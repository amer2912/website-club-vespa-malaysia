/* =========================================================
   Vespa Club Malaysia: event pick-up counter (acara/kaunter.html)
   For the event's organisers and VCM AJK. Scan the buyer's QR,
   then record entry and T-shirt pick-up. Access is enforced by
   the database (event_staff / admins), not by this page.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const note = (text, kind = "info") => { const el = $("#ct-msg"); el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const time = (ts) => ts ? new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : "";
  const codeFrom = (text) => (String(text || "").match(/[0-9a-fA-F]{32}/) || [])[0]?.toLowerCase() || null;

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) { note("Sistem belum disediakan.", "error"); return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let events = [];
  let current = null;      // selected event
  let pendingEmail = "";

  /* ---------- login ---------- */
  // Username login: counter accounts are created by AJK in Supabase as
  // <username>@kaunter.vespaclubmalaysia.com with a password (no email is sent).
  const COUNTER_DOMAIN = "kaunter.vespaclubmalaysia.com";
  const loginEmail = (u) => (u.includes("@") ? u : `${u}@${COUNTER_DOMAIN}`).toLowerCase();
  $("#ct-pass-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("#ct-user").value.trim();
    const password = $("#ct-pass").value;
    if (!user || !password) { note("Sila isi username dan kata laluan.", "error"); return; }
    const btn = $("#ct-pass-form button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: loginEmail(user), password });
    btn.disabled = false;
    if (error) { note("Username atau kata laluan salah.", "error"); return; }
    $("#ct-pass").value = "";
    start();
  });
  $("#ct-use-email").addEventListener("click", () => { $("#ct-pass-form").hidden = true; $("#ct-email-form").hidden = false; note(""); });
  $("#ct-use-pass").addEventListener("click", () => { $("#ct-email-form").hidden = true; $("#ct-code-form").hidden = true; $("#ct-pass-form").hidden = false; note(""); });

  $("#ct-email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pendingEmail = $("#ct-email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(pendingEmail)) { note("Sila masukkan emel yang sah.", "error"); return; }
    const { error } = await sb.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: true } });
    if (error) { note(error.message, "error"); return; }
    $("#ct-code-email").textContent = pendingEmail;
    $("#ct-email-form").hidden = true;
    $("#ct-code-form").hidden = false;
    note("");
  });
  $("#ct-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#ct-code").value.replace(/\s/g, "");
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
    if (error) { note("Kod salah atau sudah tamat tempoh.", "error"); return; }
    start();
  });
  $("#ct-logout").addEventListener("click", async () => { stopScan(); await sb.auth.signOut(); location.reload(); });

  async function start() {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) { $("#ct-login").hidden = false; $("#ct-main").hidden = true; return; }
    $("#ct-login").hidden = true;
    const { data, error } = await sb.rpc("event_my_events");
    events = data || [];
    if (error || !events.length) {
      note("Akaun ini tiada akses kaunter untuk mana-mana acara. Minta AJK VCM tambah emel anda sebagai penganjur.", "error");
      $("#ct-main").hidden = false;
      $$(".ct-tabs, [data-pane]").forEach((el) => { el.hidden = true; });
      return;
    }
    $("#ct-event").innerHTML = events.map((ev) => `<option value="${esc(ev.id)}">${esc(ev.title)}</option>`).join("");
    $("#ct-event-field").hidden = events.length < 2;
    selectEvent(events[0].id);
    $("#ct-main").hidden = false;
    note("");
  }
  $("#ct-event").addEventListener("change", (e) => selectEvent(e.target.value));
  function selectEvent(id) {
    current = events.find((ev) => ev.id === id);
    $("#ct-event-name").textContent = `${current.title}${current.can_work ? "" : " · lihat sahaja"}`;
    $("#ct-results").innerHTML = "";
    if (!$("[data-pane=summary]").hidden) loadSummary();
  }

  /* ---------- tabs ---------- */
  $$(".ct-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    $$(".ct-tabs [data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab !== "scan") stopScan();
    if (b.dataset.tab === "summary") loadSummary();
  }));

  /* ---------- ticket card ---------- */
  const dlg = $("#ct-card-dialog");
  async function openTicket(code, action = null) {
    const { data, error } = await sb.rpc("event_counter", { p_code: code, p_action: action });
    const t = Array.isArray(data) ? data[0] : data;
    if (error || !t) { showCard(null, error?.message || "Tiket tidak dijumpai."); return; }
    if (t.event_id !== current?.id) {
      const other = events.find((ev) => ev.id === t.event_id);
      showCard(null, `Tiket ini untuk acara lain${other ? `: ${other.title}` : ""}.`);
      return;
    }
    if (t.shirt_size === "Custom") {
      const { data: extra } = await sb.from("event_orders").select("size_note").eq("id", t.order_id).maybeSingle();
      t.size_note = extra?.size_note || "";
    }
    showCard(t, null, code, action);
  }

  function showCard(t, error, code, action) {
    const card = $("#ct-card");
    if (!t) {
      card.className = "panel ct-card is-bad";
      card.innerHTML = `<div class="ct-badge">⛔ ${esc(error)}</div><div class="form-actions"><button class="btn" type="button" data-close>Tutup</button></div>`;
    } else {
      const paid = t.status === "paid";
      const allDone = t.checked_in_at && t.shirt_collected_at;
      const state = !paid ? ["is-bad", "⛔ BELUM DIBAYAR"]
        : t.already ? ["is-bad", `⛔ SUDAH DITUNTUT${t.shirt_collected_at ? ` · ${time(t.shirt_collected_at)} oleh ${t.shirt_collected_by}` : ""}`]
        : allDone ? ["is-done", "✅ SELESAI: hadir dan baju diserahkan"]
        : ["is-ok", "✅ SAH · BELUM DITUNTUT"];
      card.className = `panel ct-card ${state[0]}`;
      const can = paid && current.can_work;
      card.innerHTML = `
        <div class="ct-badge">${esc(state[1])}</div>
        <p class="ct-no">${esc(t.order_no || "—")}</p>
        <h2>${esc(t.full_name)}</h2>
        <p class="muted">${esc(t.phone)} · ${esc([t.moto_type, t.moto_model].filter(Boolean).join(" "))}</p>
        <dl class="ticket__rows">
          <div><dt>Saiz baju</dt><dd class="ct-size">${esc(t.shirt_size)}${t.size_note ? `<div class="muted" style="font-size:.85rem">${esc(t.size_note)}</div>` : ""}</dd></div>
          <div><dt>Hadir</dt><dd>${t.checked_in_at ? `Ya · ${esc(time(t.checked_in_at))} (${esc(t.checked_in_by || "")})` : "Belum"}</dd></div>
          <div><dt>Baju</dt><dd>${t.shirt_collected_at ? `Diserahkan · ${esc(time(t.shirt_collected_at))} (${esc(t.shirt_collected_by || "")})` : "Belum diambil"}</dd></div>
        </dl>
        <div class="form-actions">
          ${can && !t.checked_in_at ? `<button class="btn btn--line" type="button" data-act="checkin">Tanda hadir</button>` : ""}
          ${can && !t.shirt_collected_at ? `<button class="btn btn--line" type="button" data-act="shirt">Serah baju</button>` : ""}
          ${can && !t.checked_in_at && !t.shirt_collected_at ? `<button class="btn btn--mint" type="button" data-act="both">Serah semua</button>` : ""}
          <button class="btn ${can && !allDone ? "btn--line" : ""}" type="button" data-close>Tutup</button>
        </div>`;
      card.dataset.code = code;
      if (action && !t.already && navigator.vibrate) navigator.vibrate(60);
    }
    if (!dlg.open) dlg.showModal();
  }
  $("#ct-card").addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) { dlg.close(); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    b.disabled = true;
    await openTicket($("#ct-card").dataset.code, b.dataset.act);
  });
  dlg.addEventListener("close", () => {
    lastAt = Date.now();
    if (!$("[data-pane=scan]").hidden && scanning === false && wantScan) startScan();
  });

  /* ---------- scanning ---------- */
  let stream = null;
  let scanning = false;
  let wantScan = false;
  let lastCode = null, lastAt = 0;   // ignore the same QR for a moment after its card is closed
  const video = $("#ct-video");
  const canvas = document.createElement("canvas");
  async function startScan() {
    if (!window.jsQR) { note("Pengimbas tidak dapat dimuatkan. Guna kotak di bawah atau tab Cari.", "error"); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
      note("Kamera tidak dapat dibuka. Benarkan akses kamera untuk laman ini, atau guna tab Cari.", "error");
      return;
    }
    wantScan = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    $("#ct-camera").hidden = false; $("#ct-scan").hidden = true; $("#ct-stop").hidden = false;
    scanning = true;
    requestAnimationFrame(tick);
  }
  function stopScan(keepWanted = false) {
    scanning = false;
    if (!keepWanted) wantScan = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $("#ct-camera").hidden = true; $("#ct-scan").hidden = false; $("#ct-stop").hidden = true;
  }
  function tick() {
    if (!scanning) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const hit = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
      const code = hit && codeFrom(hit.data);
      if (code && !(code === lastCode && Date.now() - lastAt < 4000)) {
        lastCode = code; lastAt = Date.now();
        stopScan(true); openTicket(code); return;
      }
    }
    requestAnimationFrame(tick);
  }
  $("#ct-scan").addEventListener("click", startScan);
  $("#ct-stop").addEventListener("click", () => stopScan());
  $("#ct-manual").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = codeFrom($("#ct-code-in").value);
    if (!code) { note("Pautan atau kod tiket tidak sah.", "error"); return; }
    note("");
    openTicket(code);
  });

  /* ---------- search ---------- */
  let searchTimer = null;
  $("#ct-q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); });
  async function search() {
    const q = $("#ct-q").value.trim().replace(/[%,()*]/g, " ").trim();
    if (q.length < 2) { $("#ct-results").innerHTML = ""; return; }
    const digits = q.replace(/\D/g, "");
    const ors = [`full_name.ilike.*${q}*`, `order_no.ilike.*${q}*`, `email.ilike.*${q}*`];
    if (digits.length >= 3) ors.push(`phone.ilike.*${digits.slice(-7)}*`);
    const { data, error } = await sb.from("event_orders")
      .select("ticket_code, order_no, full_name, phone, shirt_size, size_note, checked_in_at, shirt_collected_at")
      .eq("event_id", current.id).eq("status", "paid").or(ors.join(",")).order("order_no").limit(30);
    if (error) { $("#ct-results").innerHTML = `<li class="muted">${esc(error.message)}</li>`; return; }
    $("#ct-results").innerHTML = (data || []).map((r) => `
      <li><button type="button" class="ct-row" data-code="${esc(r.ticket_code)}">
        <span><strong>${esc(r.full_name)}</strong><span class="muted"> · ${esc(r.order_no)} · ${esc(r.phone)}</span></span>
        <span class="pill ${r.shirt_collected_at ? "pill--active" : "pill--new"}">${esc(r.shirt_size)}${r.size_note ? ` (${esc(r.size_note)})` : ""} · ${r.shirt_collected_at ? "Diambil" : "Belum"}</span>
      </button></li>`).join("") || `<li class="muted">Tiada padanan.</li>`;
  }
  $("#ct-results").addEventListener("click", (e) => { const b = e.target.closest("[data-code]"); if (b) openTicket(b.dataset.code); });

  /* ---------- summary ---------- */
  let paidRows = [];
  async function loadSummary() {
    paidRows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("event_orders")
        .select("order_no, full_name, phone, email, moto_type, moto_model, shirt_size, size_note, interests, amount_cents, paid_at, checked_in_at, checked_in_by, shirt_collected_at, shirt_collected_by")
        .eq("event_id", current.id).eq("status", "paid").order("order_no").range(from, from + 999);
      if (error) { note(error.message, "error"); return; }
      paidRows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const n = paidRows.length;
    const cents = paidRows.reduce((s, r) => s + (r.amount_cents || 0), 0);
    const tiles = [
      [n, "Tiket dibayar"], [`RM${(cents / 100).toLocaleString("en-MY")}`, "Jumlah jualan"],
      [paidRows.filter((r) => r.checked_in_at).length, "Sudah hadir"], [paidRows.filter((r) => r.shirt_collected_at).length, "Baju diserahkan"],
    ];
    $("#ct-kpis").innerHTML = tiles.map(([v, l]) => `<div><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join("");
    const interest = {};
    paidRows.forEach((r) => (r.interests || []).forEach((i) => { interest[i] = (interest[i] || 0) + 1; }));
    const both = paidRows.filter((r) => (r.interests || []).length >= 2).length;
    $("#ct-interests").innerHTML = Object.entries(interest).map(([k, v]) => `<li><span>${esc(k)}</span><strong>${v}</strong></li>`).join("")
      + (Object.keys(interest).length >= 2 ? `<li><span>Kedua-duanya</span><strong>${both}</strong></li>` : "");
    $("#ct-interests-wrap").hidden = !Object.keys(interest).length;
    const sizes = {};
    paidRows.forEach((r) => { const s = (sizes[r.shirt_size] ||= { paid: 0, got: 0 }); s.paid++; if (r.shirt_collected_at) s.got++; });
    const order = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "Custom"];
    $("#ct-sizes").innerHTML = Object.keys(sizes).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
      .map((s) => `<tr><td><strong>${esc(s)}</strong></td><td class="num">${sizes[s].paid}</td><td class="num">${sizes[s].got}</td><td class="num">${sizes[s].paid - sizes[s].got}</td></tr>`).join("")
      || `<tr><td colspan="4" class="muted">Belum ada jualan.</td></tr>`;
  }
  const csvCell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  $("#ct-csv").addEventListener("click", async () => {
    if (!paidRows.length) await loadSummary();
    const cols = ["order_no", "full_name", "phone", "email", "moto_type", "moto_model", "shirt_size", "size_note", "interests", "paid_at", "checked_in_at", "checked_in_by", "shirt_collected_at", "shirt_collected_by"];
    const lines = [cols.join(",")].concat(paidRows.map((r) => cols.map((c) => csvCell(c === "interests" ? (r.interests || []).join("; ") : r[c])).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${current.id}-pembeli-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  start();
})();
