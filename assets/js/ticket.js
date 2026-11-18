/* =========================================================
   Vespa Club Malaysia: event ticket page (acara/tiket.html)
   Opened from the ToyyibPay return link or the receipt email.
   The secret code in the address is the ticket; the QR code
   holds the same link for the counter to scan.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s) => document.querySelector(s);
  const note = (text, kind = "info") => { const el = $("#tk-msg"); el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const fmt = (ts) => ts ? new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : "—";
  const fmtDate = (d) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
  const params = new URLSearchParams(location.search);
  const code = (params.get("code") || "").toLowerCase();
  const billcode = params.get("billcode");
  const done = () => { $("#tk-loading").hidden = true; };
  const PACK_EVENTS = new Set(["vespa-day-2026"]);

  if (!/^[0-9a-f]{32}$/.test(code)) { done(); note("This ticket link is not complete. Open the link from your receipt email again.", "error"); return; }
  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) { done(); note("Tickets are not available yet.", "error"); return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });
  // Keep only the ticket code in the address bar (drop the payment details).
  if (billcode || params.get("status_id")) history.replaceState(null, "", `${location.pathname}?code=${code}`);

  async function load() {
    const { data, error } = await sb.rpc("event_ticket", { p_code: code });
    const t = Array.isArray(data) ? data[0] : data;
    if (error || !t) return null;
    return t;
  }

  function render(t) {
    try { localStorage.setItem(`vcm-ticket-${t.event_id}`, code); } catch { /* private mode */ }
    $("#tk-back").href = `${t.event_id === "isd-2026" ? "isd2026" : t.event_id}.html`;
    $("#tk-title").textContent = t.title;
    $("#tk-when").textContent = `${fmtDate(t.event_date)} · ${t.venue || ""}`;
    $("#tk-no").textContent = t.order_no || "Given after payment";
    $("#tk-name").textContent = t.full_name;
    $("#tk-size").textContent = t.shirt_size;
    $("#tk-moto").textContent = [t.moto_type, t.moto_model].filter((v) => v && v !== "-").join(" · ");
    // Fixed packs (one size "Pack", no scooter question "-") leave those rows out.
    $("#tk-size").parentElement.hidden = t.shirt_size === "Pack";
    $("#tk-moto").parentElement.hidden = t.moto_type === "-" && !t.moto_model;
    if (t.moto_type === "-") $("#tk-moto").parentElement.querySelector("dt").textContent = "Vespa";
    // Events that sell a merchandise pack (not just a T-shirt) say "pack".
    if (t.shirt_size === "Pack" || PACK_EVENTS.has(t.event_id)) {
      $("#tk-collected").parentElement.querySelector("dt").textContent = "Pack · Pek";
      $("#tk-hint").innerHTML = 'Show this QR code at the counter to collect your pack. A screenshot works too.<br><span class="muted">Tunjukkan kod QR ini di kaunter untuk ambil pek anda. Screenshot pun boleh.</span>';
    }
    $("#tk-paid").textContent = t.status === "paid" ? `RM${(t.amount_cents / 100).toFixed(2)} · ${fmt(t.paid_at)}` : "Not yet";
    $("#tk-collected").textContent = t.shirt_collected_at ? `Collected · ${fmt(t.shirt_collected_at)}` : "Not collected yet";
    const hideContact = window.VCM_MAINTENANCE?.hideContactNumber === true;
    $("#tk-org").textContent = t.organizer_contact && !hideContact ? `Enquiries · Pertanyaan: ${t.organizer_contact}` : "";
    const paid = t.status === "paid";
    $("#tk").classList.toggle("is-pending", !paid);
    $("#tk-status-label").textContent = paid ? "Paid ticket · Tiket dibayar" : t.status === "failed" ? "Payment not completed" : "Waiting for payment";
    $("#tk-hint").hidden = !paid;
    if (paid && window.qrcode) {
      const qr = window.qrcode(0, "M");
      qr.addData(`${location.origin}${location.pathname}?code=${code}`);
      qr.make();
      $("#tk-qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } else {
      $("#tk-qr").innerHTML = "";
    }
    $("#tk").hidden = false;
    if (paid) note("");
    else if (t.status === "failed") note("The payment was not completed, so no ticket was issued. No money was taken. You can buy again on the event page.", "error");
  }

  // Ask the server to check this ticket's bill with ToyyibPay again. Uses the
  // bill code when just back from paying, otherwise the ticket code, so an
  // unpaid ticket opened later still picks up a payment that went through.
  const recheck = () => sb.functions.invoke("event-callback", { body: billcode ? { billcode } : { code } }).catch(() => null);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    if (billcode) await recheck();
    let t = await load();
    if (t && t.status === "pending" && !billcode) { await recheck(); t = (await load()) || t; }
    done();
    if (!t) { note("Ticket not found. Check the link in your receipt email.", "error"); return; }
    render(t);
    // FPX banks can take a minute or two to confirm: keep checking for about 2 minutes.
    for (let i = 0; t.status === "pending" && i < 16; i++) {
      note("Confirming your payment with ToyyibPay… · Mengesahkan bayaran anda…", "info");
      await wait(i < 6 ? 4000 : 10000);
      await recheck();
      t = (await load()) || t;
      render(t);
    }
    if (t.status === "pending") {
      note("Your bank has not confirmed the payment yet. If money was taken, it is usually confirmed within a few minutes: open this link again later. Still not confirmed after an hour? WhatsApp us with your bank receipt. · Bank belum mengesahkan bayaran. Jika wang telah ditolak, buka semula pautan ini sebentar lagi.", "warn");
    } else if (t.status === "paid" && billcode) {
      note("Payment received. Thank you! Save this page or take a screenshot of the QR code.", "success");
    }
  })();
})();
