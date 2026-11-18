/* =========================================================
   Vespa Club Malaysia: event ticket sales page (acara/*.html)
   Buyers do not have to log in. The order and the ToyyibPay bill
   are created by the event-checkout Edge Function; every check
   (open, closing date, size stock, member price) happens on the
   server. Members logged in to the member portal (same site, so
   the same saved login) can choose the member price.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rm = (cents) => `RM${(cents / 100).toFixed(2)}`;
  const note = (el, text, kind = "info") => { el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const eventId = document.body.dataset.event;
  // Site-wide maintenance switch (supabase-config.js): no new online payments.
  const pause = window.VCM_MAINTENANCE || {};
  const paused = pause.paymentsPaused === true;
  const pauseText = pause.message || "Online payment is under maintenance. Please check back soon.";
  const form = $("#ev-form");
  const msg = $("#ev-msg");
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  // A ticket bought on this device: offer a link back to it.
  const last = store.get(`vcm-ticket-${eventId}`);
  if (last && /^[0-9a-f]{32}$/.test(last)) { $("#my-ticket").href = `tiket.html?code=${last}`; $("#my-ticket").hidden = false; }

  const setClosed = (text) => {
    note($("#ev-closed"), text, "warn");
    [...form.elements].forEach((el) => { el.disabled = true; });
  };

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) { setClosed("Ticket sales open soon."); return; }
  // Shares the member portal's saved login (if any) so members get the member price.
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  let price = 0;           // normal price (cents)
  let memberPrice = null;  // member price (cents) when the event has one
  const memberBox = $("#ev-member");
  const useMember = () => !!$("#ev-use-member")?.checked;
  const showTotal = () => { if (price) $("#ev-total").textContent = rm(useMember() ? memberPrice : price); };
  const loginLink = () => `../ahli/?next=${encodeURIComponent(location.pathname)}`;
  const fmtDay = (d) => d ? new Date(`${d}T00:00:00+08:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }) : "—";
  let member = null;

  function setMemberMode(on) {
    const name = $("#ev-name");
    name.readOnly = on;
    if (on && member) {
      name.value = member.full_name || name.value;
      if (!$("#ev-phone").value && member.phone) $("#ev-phone").value = member.phone;
      if (!$("#ev-email").value && member.email) $("#ev-email").value = member.email;
    }
    showTotal();
  }

  async function loadMember() {
    if (!memberBox) return;
    if (paused) { memberBox.hidden = true; return; }
    const { data: mp } = await sb.rpc("event_member_price", { p_event: eventId });
    memberPrice = Number(mp) || null;
    if (!memberPrice) { memberBox.hidden = true; return; }
    const pct = price ? Math.round((1 - memberPrice / price) * 100) : 0;
    const off = pct > 0 ? `${pct}% OFF` : "";
    const priceNote = $("#ev-member-price-note");
    if (priceNote) priceNote.textContent = `${rm(memberPrice).replace(".00", "")} for active VCM members`;
    const badge = $("#ev-save-badge");
    if (badge) { badge.hidden = !off; if (off) badge.innerHTML = `VCM members<b>${off}</b>`; }
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) {
      memberBox.innerHTML = `${off ? `<span class="save-chip">${esc(off)} for members · Jimat ${pct}%</span>` : ""}<strong>Active VCM member? Pay ${esc(rm(memberPrice))} instead of ${esc(rm(price))}.</strong>
        <span>Ahli VCM aktif? Log masuk portal ahli untuk harga ahli. You will come back here after logging in.</span>
        <a class="btn btn--small" href="${loginLink()}">Log in for member price · Log masuk</a>`;
      memberBox.hidden = false;
      return;
    }
    const { data, error } = await sb.rpc("event_member_quote", { p_event: eventId });
    const q = Array.isArray(data) ? data[0] : data;
    if (error || !q) { memberBox.hidden = true; return; }
    member = q;
    const who = `${esc(q.full_name || q.email || "")}${q.member_no ? ` · ${esc(q.member_no)}` : ""}`;
    const logout = `<button type="button" class="link-btn" id="ev-logout">Not you? Log out · Log keluar</button>`;
    const html = {
      ok: `<label class="check member-box__check"><input type="checkbox" id="ev-use-member" checked>
             <span><strong>Member price ${esc(rm(memberPrice))} for my own pack</strong>${off ? ` <span class="save-chip">${esc(off)}</span>` : ""} · Harga ahli untuk pek saya<br><span class="muted">${who}</span></span></label>
           <span class="muted">Untick to buy an extra pack for someone else at ${esc(rm(price))}. · Buang tanda untuk beli pek tambahan untuk orang lain.</span>`,
      used: `<strong>You have already bought your member-price pack.</strong>
             <span>Anda telah membeli pek harga ahli. Extra packs are ${esc(rm(price))}. · ${who}</span>`,
      expired: `<strong>Your membership is not active on the event date</strong> (valid until ${esc(fmtDay(q.expires_on))}).
             <span>Keahlian anda perlu diperbaharui. Renew in the member portal, then come back for the member price.</span>
             <a class="btn btn--small" href="${loginLink()}">Renew membership · Perbaharui</a>`,
      profile: `<strong>Please complete your member profile first.</strong>
             <span>Sila lengkapkan profil ahli dahulu, kemudian anda akan dibawa kembali ke sini.</span>
             <a class="btn btn--small" href="${loginLink()}">Complete profile · Lengkapkan profil</a>`,
      not_member: `<strong>This login (${esc(q.email || "")}) is not linked to a VCM membership.</strong>
             <span>Emel ini tiada dalam rekod keahlian. Log in with the email in your membership record, or WhatsApp the club secretary below.</span>`,
    }[q.status];
    if (!html) { memberBox.hidden = true; return; }
    memberBox.innerHTML = html + logout;
    memberBox.hidden = false;
    $("#ev-logout")?.addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
    $("#ev-use-member")?.addEventListener("change", (e) => setMemberMode(e.target.checked));
    setMemberMode(useMember());
  }

  async function load() {
    const { data, error } = await sb.rpc("event_public", { p_event: eventId });
    const ev = Array.isArray(data) ? data[0] : data;
    if (!error && !ev) { setClosed("Sales open soon. · Jualan akan dibuka tidak lama lagi."); return; }
    if (error) { setClosed("Could not load ticket sales. Please refresh the page."); return; }
    $("#ev-price").textContent = `RM${(ev.price_cents / 100).toFixed(ev.price_cents % 100 ? 2 : 0)}`;
    price = ev.price_cents;
    $("#ev-total").textContent = rm(useMember() && memberPrice ? memberPrice : ev.price_cents);
    // e.g. "29 Nov 2026, 6:00 pm" (the time is left out when sales run to the end of the day)
    const close = new Date(ev.sales_close_at);
    const day = close.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
    const hm = close.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kuala_Lumpur" });
    const clock = close.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }).toLowerCase();
    $("#ev-close").textContent = hm === "23:59" ? day : `${day}, ${clock}`;
    $("#ev-type").innerHTML = `<option value="">Choose · Pilih</option>` + ev.moto_types.map((t) => `<option>${esc(t)}</option>`).join("");
    const soldOut = new Set(ev.sold_out_sizes || []);
    $("#ev-sizes").innerHTML = ev.sizes.map((s) => `
      <label class="size-chip${soldOut.has(s) ? " is-off" : ""}">
        <input type="radio" name="ev-size" value="${esc(s)}"${soldOut.has(s) ? " disabled" : ""}>
        <span>${esc(s)}${soldOut.has(s) ? "<small>Sold out</small>" : ""}</span>
      </label>`).join("");
    const options = ev.interest_options || [];
    $("#ev-interests").innerHTML = options.map((o, i) => `
      <label class="check"><input type="checkbox" name="ev-interest" value="${esc(o)}" id="ev-int-${i}"> <span>${esc(o)}</span></label>`).join("");
    $("#ev-interest-field").hidden = !options.length;
    // An event with a single size or scooter choice (e.g. a fixed merchandise
    // pack) does not ask: the only value is chosen for the buyer and hidden.
    const onlySize = ev.sizes.length === 1;
    $("#ev-sizes").closest(".size-field").hidden = onlySize;
    if (onlySize) { const r = form.querySelector("input[name=ev-size]"); if (r && !r.disabled) r.checked = true; }
    // A single scooter choice is not asked; the (optional) model box stays and takes the full row.
    const onlyType = ev.moto_types.length === 1;
    $("#ev-type").closest(".field").hidden = onlyType;
    $("#ev-type").closest(".form-row").style.gridTemplateColumns = onlyType ? "1fr" : "";
    if (onlyType) $("#ev-type").value = ev.moto_types[0];
    if (paused) setClosed(pauseText);
    else if (!ev.open) setClosed(ev.closed_reason || "Ticket sales are closed.");
  }

  const value = (id) => $(id).value.trim();
  // The Custom size asks for a pit / chest measurement.
  form.addEventListener("change", (e) => {
    if (e.target.name !== "ev-size") return;
    const custom = e.target.value === "Custom";
    $("#ev-note-field").hidden = !custom;
    if (custom) $("#ev-note").focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (paused) { note(msg, pauseText, "warn"); return; }
    const size = form.querySelector("input[name=ev-size]:checked")?.value;
    const missing = [];
    const custom = size === "Custom";
    if (value("#ev-name").length < 2) missing.push("full name");
    if (!/^\+?[0-9][0-9 -]{7,18}$/.test(value("#ev-phone"))) missing.push("a valid phone number");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value("#ev-email"))) missing.push("a valid email");
    if (!value("#ev-type")) missing.push("scooter type");
    if (!size) missing.push("T-shirt size");
    if (custom && value("#ev-note").length < 2) missing.push("your pit / chest measurement for the Custom size");
    if (!$("#ev-agree").checked) missing.push("the agreement tick box");
    if (missing.length) { note(msg, `Please fill in: ${missing.join(", ")}.`, "error"); return; }

    const btn = $("#ev-pay");
    btn.disabled = true;
    note(msg, "Starting payment…", "info");
    const { data, error } = await sb.functions.invoke("event-checkout", {
      body: { event: eventId, full_name: value("#ev-name"), phone: value("#ev-phone"), email: value("#ev-email"),
              moto_type: value("#ev-type"), moto_model: value("#ev-model"), shirt_size: size,
              size_note: custom ? value("#ev-note") : "",
              interests: [...form.querySelectorAll("input[name=ev-interest]:checked")].map((c) => c.value),
              use_member: useMember() },
    });
    if (error || !data?.url) {
      let text = "Could not start the payment. Please try again.";
      try { const body = await error?.context?.json(); if (body?.error) text = body.error; } catch { /* keep default */ }
      btn.disabled = false;
      note(msg, text, "error");
      load().then(loadMember);
      return;
    }
    if (data.ticket) store.set(`vcm-ticket-${eventId}`, data.ticket);
    location.href = data.url;
  });

  load().then(() => loadMember().catch(() => { memberBox && (memberBox.hidden = true); }));
})();
