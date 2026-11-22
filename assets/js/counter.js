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

  /* ---------- language: English (default) or Bahasa Melayu ---------- */
  const STR = {
    en: {
      notSetUp: "The system is not set up yet.", fillLogin: "Please enter your username and password.", badLogin: "Wrong username or password.",
      badEmail: "Please enter a valid email.", badCode: "Wrong or expired code.",
      noAccess: "This account has no counter access for any event. Ask the VCM AJK to add your email as an organiser.",
      viewOnly: " · view only", notFound: "Ticket not found.", otherEvent: (t) => `This ticket is for another event${t ? `: ${t}` : ""}.`,
      close: "Close", unpaid: "⛔ NOT PAID", claimed: (w, by) => `⛔ ALREADY CLAIMED${w ? ` · ${w} by ${by}` : ""}`,
      done: "✅ DONE: checked in and item handed over", valid: "✅ VALID · NOT CLAIMED YET",
      size: "Size", changedFrom: (s, w, by) => `Changed from ${s} · ${w} (${by})`, checkedIn: "Checked in", yes: "Yes", no: "Not yet",
      item: "T-shirt / pack", handed: "Handed over", notCollected: "Not collected yet",
      markIn: "Check in", giveItem: "Hand over item", giveAll: "Hand over all", changeSize: "Change size",
      changeSizeTitle: "Change T-shirt size", superOnly: "Super admin only. The buyer's original size is recorded.", newSize: "New size",
      customSize: "Custom measurement", customEg: "e.g. chest 52 inches", saveSize: "Save size", cancel: "Cancel", sizeChanged: (s) => `Size changed to ${s}.`,
      noScanner: "The scanner could not load. Use the box below or the Search tab.",
      noCamera: "The camera could not open. Allow camera access for this site, or use the Search tab.",
      badLink: "Not a valid ticket link or code.", collected: "Collected", notYet: "Not yet", noMatch: "No matches.",
      kPaid: "Paid tickets", kSales: "Total sales", kIn: "Checked in", kGiven: "Items handed over", both: "Both", noSales: "No sales yet.",
      lang: "Bahasa Melayu",
    },
    ms: {
      notSetUp: "Sistem belum disediakan.", fillLogin: "Sila isi username dan kata laluan.", badLogin: "Username atau kata laluan salah.",
      badEmail: "Sila masukkan emel yang sah.", badCode: "Kod salah atau sudah tamat tempoh.",
      noAccess: "Akaun ini tiada akses kaunter untuk mana-mana acara. Minta AJK VCM tambah emel anda sebagai penganjur.",
      viewOnly: " · lihat sahaja", notFound: "Tiket tidak dijumpai.", otherEvent: (t) => `Tiket ini untuk acara lain${t ? `: ${t}` : ""}.`,
      close: "Tutup", unpaid: "⛔ BELUM DIBAYAR", claimed: (w, by) => `⛔ SUDAH DITUNTUT${w ? ` · ${w} oleh ${by}` : ""}`,
      done: "✅ SELESAI: hadir dan baju diserahkan", valid: "✅ SAH · BELUM DITUNTUT",
      size: "Saiz baju", changedFrom: (s, w, by) => `Ditukar dari ${s} · ${w} (${by})`, checkedIn: "Hadir", yes: "Ya", no: "Belum",
      item: "Baju", handed: "Diserahkan", notCollected: "Belum diambil",
      markIn: "Tanda hadir", giveItem: "Serah baju", giveAll: "Serah semua", changeSize: "Tukar saiz",
      changeSizeTitle: "Tukar saiz baju", superOnly: "Hanya super admin. Saiz asal pembeli akan direkodkan.", newSize: "Saiz baharu",
      customSize: "Ukuran custom", customEg: "cth dada 52 inci", saveSize: "Simpan saiz", cancel: "Batal", sizeChanged: (s) => `Saiz ditukar ke ${s}.`,
      noScanner: "Pengimbas tidak dapat dimuatkan. Guna kotak di bawah atau tab Cari.",
      noCamera: "Kamera tidak dapat dibuka. Benarkan akses kamera untuk laman ini, atau guna tab Cari.",
      badLink: "Pautan atau kod tiket tidak sah.", collected: "Diambil", notYet: "Belum", noMatch: "Tiada padanan.",
      kPaid: "Tiket dibayar", kSales: "Jumlah jualan", kIn: "Sudah hadir", kGiven: "Baju diserahkan", both: "Kedua-duanya", noSales: "Belum ada jualan.",
      lang: "English",
    },
  };
  let lang = "en";
  try { lang = localStorage.getItem("vcm-ct-lang") === "ms" ? "ms" : "en"; } catch { /* storage blocked */ }
  const tr = (k, ...a) => { const v = STR[lang][k]; return typeof v === "function" ? v(...a) : v; };
  function applyStaticText() {
    document.documentElement.lang = lang;
    $$("[data-en]").forEach((el) => { el.textContent = lang === "ms" ? el.dataset.ms : el.dataset.en; });
    $$("[data-en-ph]").forEach((el) => { el.placeholder = lang === "ms" ? el.dataset.msPh : el.dataset.enPh; });
    $("#ct-lang").textContent = tr("lang");
  }

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) { note(tr("notSetUp"), "error"); return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let events = [];
  let current = null;      // selected event
  let pendingEmail = "";
  let sizeOptions = null;  // sizes the super admin may switch to (null for everyone else)

  /* ---------- login ---------- */
  // Username login: counter accounts are created by AJK in Supabase as
  // <username>@kaunter.vespaclubmalaysia.com with a password (no email is sent).
  const COUNTER_DOMAIN = "kaunter.vespaclubmalaysia.com";
  const loginEmail = (u) => (u.includes("@") ? u : `${u}@${COUNTER_DOMAIN}`).toLowerCase();
  $("#ct-pass-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("#ct-user").value.trim();
    const password = $("#ct-pass").value;
    if (!user || !password) { note(tr("fillLogin"), "error"); return; }
    const btn = $("#ct-pass-form button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: loginEmail(user), password });
    btn.disabled = false;
    if (error) { note(tr("badLogin"), "error"); return; }
    $("#ct-pass").value = "";
    start();
  });
  $("#ct-use-email").addEventListener("click", () => { $("#ct-pass-form").hidden = true; $("#ct-email-form").hidden = false; note(""); });
  $("#ct-use-pass").addEventListener("click", () => { $("#ct-email-form").hidden = true; $("#ct-code-form").hidden = true; $("#ct-pass-form").hidden = false; note(""); });

  $("#ct-email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pendingEmail = $("#ct-email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(pendingEmail)) { note(tr("badEmail"), "error"); return; }
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
    if (error) { note(tr("badCode"), "error"); return; }
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
      note(tr("noAccess"), "error");
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
  async function selectEvent(id) {
    current = events.find((ev) => ev.id === id);
    sizeOptions = null;
    if (current.can_work) {
      // Only the super admin gets a list back; counter accounts and other AJK get null.
      const { data, error } = await sb.rpc("event_size_options", { p_event: id });
      if (current?.id === id) sizeOptions = !error && Array.isArray(data) && data.length ? data : null;
    }
    $("#ct-event-name").textContent = `${current.title}${current.can_work ? "" : tr("viewOnly")}`;
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
    if (error || !t) { showCard(null, error?.message || tr("notFound")); return; }
    if (t.event_id !== current?.id) {
      const other = events.find((ev) => ev.id === t.event_id);
      showCard(null, tr("otherEvent", other?.title));
      return;
    }
    // Size note and size change record (the change columns exist once SQL 015 is run).
    const more = await sb.from("event_orders").select("size_note, size_changed_from, size_changed_at, size_changed_by").eq("id", t.order_id).maybeSingle();
    if (!more.error && more.data) Object.assign(t, more.data);
    else if (t.shirt_size === "Custom") {
      const { data: extra } = await sb.from("event_orders").select("size_note").eq("id", t.order_id).maybeSingle();
      t.size_note = extra?.size_note || "";
    }
    showCard(t, null, code, action);
  }

  function showCard(t, error, code, action) {
    const card = $("#ct-card");
    if (!t) {
      card.className = "panel ct-card is-bad";
      card.innerHTML = `<div class="ct-badge">⛔ ${esc(error)}</div><div class="form-actions"><button class="btn" type="button" data-close>${tr("close")}</button></div>`;
    } else {
      const paid = t.status === "paid";
      const allDone = t.checked_in_at && t.shirt_collected_at;
      const state = !paid ? ["is-bad", tr("unpaid")]
        : t.already ? ["is-bad", tr("claimed", t.shirt_collected_at ? time(t.shirt_collected_at) : "", t.shirt_collected_by)]
        : allDone ? ["is-done", tr("done")]
        : ["is-ok", tr("valid")];
      card.className = `panel ct-card ${state[0]}`;
      const can = paid && current.can_work;
      card.innerHTML = `
        <div class="ct-badge">${esc(state[1])}</div>
        <p class="ct-no">${esc(t.order_no || "—")}</p>
        <h2>${esc(t.full_name)}</h2>
        <p class="muted">${esc(t.phone)} · ${esc([t.moto_type, t.moto_model].filter((v) => v && v !== "-").join(" "))}</p>
        <dl class="ticket__rows">
          <div><dt>${tr("size")}</dt><dd class="ct-size">${esc(t.shirt_size)}${t.size_note ? `<div class="muted" style="font-size:.85rem">${esc(t.size_note)}</div>` : ""}${t.size_changed_from && t.size_changed_from !== t.shirt_size ? `<div class="ct-size-changed">${esc(tr("changedFrom", t.size_changed_from, time(t.size_changed_at), t.size_changed_by || ""))}</div>` : ""}</dd></div>
          <div><dt>${tr("checkedIn")}</dt><dd>${t.checked_in_at ? `${tr("yes")} · ${esc(time(t.checked_in_at))} (${esc(t.checked_in_by || "")})` : tr("no")}</dd></div>
          <div><dt>${tr("item")}</dt><dd>${t.shirt_collected_at ? `${tr("handed")} · ${esc(time(t.shirt_collected_at))} (${esc(t.shirt_collected_by || "")})` : tr("notCollected")}</dd></div>
        </dl>
        <div class="form-actions">
          ${can && !t.checked_in_at ? `<button class="btn btn--line" type="button" data-act="checkin">${tr("markIn")}</button>` : ""}
          ${can && !t.shirt_collected_at ? `<button class="btn btn--line" type="button" data-act="shirt">${tr("giveItem")}</button>` : ""}
          ${can && !t.checked_in_at && !t.shirt_collected_at ? `<button class="btn btn--mint" type="button" data-act="both">${tr("giveAll")}</button>` : ""}
          ${paid && sizeOptions ? `<button class="btn btn--line" type="button" data-resize>${tr("changeSize")}</button>` : ""}
          <button class="btn ${can && !allDone ? "btn--line" : ""}" type="button" data-close>${tr("close")}</button>
        </div>
        ${paid && sizeOptions ? `
        <form class="ct-resize" data-resize-form hidden novalidate>
          <h3>${tr("changeSizeTitle")}</h3>
          <p class="muted">${tr("superOnly")}</p>
          <div class="field"><label for="ct-new-size">${tr("newSize")}</label>
            <select id="ct-new-size">${sizeOptions.map((s) => `<option value="${esc(s)}"${s === t.shirt_size ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
          <div class="field" data-resize-note${t.shirt_size === "Custom" ? "" : " hidden"}><label for="ct-new-note">${tr("customSize")}</label>
            <input id="ct-new-note" maxlength="100" value="${esc(t.size_note || "")}" placeholder="${tr("customEg")}"></div>
          <p class="notice notice--error" data-resize-msg hidden></p>
          <div class="form-actions"><button class="btn btn--mint" type="submit">${tr("saveSize")}</button><button class="text-btn" type="button" data-resize-cancel>${tr("cancel")}</button></div>
        </form>` : ""}`;
      card.dataset.orderId = t.order_id;
      card.dataset.code = code;
      if (action && !t.already && navigator.vibrate) navigator.vibrate(60);
    }
    if (!dlg.open) dlg.showModal();
  }
  $("#ct-card").addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) { dlg.close(); return; }
    const form = $("[data-resize-form]", $("#ct-card"));
    if (e.target.closest("[data-resize]")) { form.hidden = false; $("#ct-new-size").focus(); return; }
    if (e.target.closest("[data-resize-cancel]")) { form.hidden = true; return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    b.disabled = true;
    await openTicket($("#ct-card").dataset.code, b.dataset.act);
  });
  $("#ct-card").addEventListener("change", (e) => {
    if (e.target.id === "ct-new-size") $("[data-resize-note]", $("#ct-card")).hidden = e.target.value !== "Custom";
  });
  $("#ct-card").addEventListener("submit", async (e) => {
    e.preventDefault();
    const card = $("#ct-card");
    const msg = $("[data-resize-msg]", card);
    const size = $("#ct-new-size").value;
    const btn = $("[data-resize-form] button[type=submit]", card);
    btn.disabled = true; msg.hidden = true;
    const { error } = await sb.rpc("event_change_size", { p_order: card.dataset.orderId, p_size: size, p_note: size === "Custom" ? $("#ct-new-note").value : null });
    btn.disabled = false;
    if (error) { msg.textContent = error.message; msg.hidden = false; return; }
    await openTicket(card.dataset.code);
    note(tr("sizeChanged", size), "success");
    if (!$("[data-pane=summary]").hidden) loadSummary();
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
    if (!window.jsQR) { note(tr("noScanner"), "error"); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
      note(tr("noCamera"), "error");
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
    if (!code) { note(tr("badLink"), "error"); return; }
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
        <span class="pill ${r.shirt_collected_at ? "pill--active" : "pill--new"}">${esc(r.shirt_size)}${r.size_note ? ` (${esc(r.size_note)})` : ""} · ${r.shirt_collected_at ? tr("collected") : tr("notYet")}</span>
      </button></li>`).join("") || `<li class="muted">${tr("noMatch")}</li>`;
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
      [n, tr("kPaid")], [`RM${(cents / 100).toLocaleString("en-MY")}`, tr("kSales")],
      [paidRows.filter((r) => r.checked_in_at).length, tr("kIn")], [paidRows.filter((r) => r.shirt_collected_at).length, tr("kGiven")],
    ];
    $("#ct-kpis").innerHTML = tiles.map(([v, l]) => `<div><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join("");
    const interest = {};
    paidRows.forEach((r) => (r.interests || []).forEach((i) => { interest[i] = (interest[i] || 0) + 1; }));
    const both = paidRows.filter((r) => (r.interests || []).length >= 2).length;
    $("#ct-interests").innerHTML = Object.entries(interest).map(([k, v]) => `<li><span>${esc(k)}</span><strong>${v}</strong></li>`).join("")
      + (Object.keys(interest).length >= 2 ? `<li><span>${tr("both")}</span><strong>${both}</strong></li>` : "");
    $("#ct-interests-wrap").hidden = !Object.keys(interest).length;
    const sizes = {};
    paidRows.forEach((r) => { const s = (sizes[r.shirt_size] ||= { paid: 0, got: 0 }); s.paid++; if (r.shirt_collected_at) s.got++; });
    const order = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL", "7XL", "Custom"];
    $("#ct-sizes").innerHTML = Object.keys(sizes).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
      .map((s) => `<tr><td><strong>${esc(s)}</strong></td><td class="num">${sizes[s].paid}</td><td class="num">${sizes[s].got}</td><td class="num">${sizes[s].paid - sizes[s].got}</td></tr>`).join("")
      || `<tr><td colspan="4" class="muted">${tr("noSales")}</td></tr>`;
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

  /* ---------- language switch ---------- */
  $("#ct-lang").addEventListener("click", () => {
    lang = lang === "en" ? "ms" : "en";
    try { localStorage.setItem("vcm-ct-lang", lang); } catch { /* storage blocked */ }
    applyStaticText();
    if (current) $("#ct-event-name").textContent = `${current.title}${current.can_work ? "" : tr("viewOnly")}`;
    if (dlg.open && $("#ct-card").dataset.code) openTicket($("#ct-card").dataset.code);
    if (!$("[data-pane=summary]").hidden) loadSummary();
    if (!$("[data-pane=search]").hidden) search();
  });
  applyStaticText();
  start();
})();
