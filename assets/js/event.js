/* =========================================================
   Vespa Club Malaysia: event ticket sales page (acara/*.html)
   Buyers do not log in. The order and the ToyyibPay bill are
   created by the event-checkout Edge Function; every check
   (open, closing date, size stock) happens on the server.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rm = (cents) => `RM${(cents / 100).toFixed(2)}`;
  const note = (el, text, kind = "info") => { el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const eventId = document.body.dataset.event;
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
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });

  async function load() {
    const { data, error } = await sb.rpc("event_public", { p_event: eventId });
    const ev = Array.isArray(data) ? data[0] : data;
    if (error || !ev) { setClosed("Could not load ticket sales. Please refresh the page."); return; }
    $("#ev-price").textContent = `RM${(ev.price_cents / 100).toFixed(ev.price_cents % 100 ? 2 : 0)}`;
    $("#ev-total").textContent = rm(ev.price_cents);
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
    if (!ev.open) setClosed(ev.closed_reason || "Ticket sales are closed.");
  }

  const value = (id) => $(id).value.trim();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const size = form.querySelector("input[name=ev-size]:checked")?.value;
    const missing = [];
    if (value("#ev-name").length < 2) missing.push("full name");
    if (!/^\+?[0-9][0-9 -]{7,18}$/.test(value("#ev-phone"))) missing.push("a valid phone number");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value("#ev-email"))) missing.push("a valid email");
    if (!value("#ev-type")) missing.push("scooter type");
    if (!size) missing.push("T-shirt size");
    if (!$("#ev-agree").checked) missing.push("the agreement tick box");
    if (missing.length) { note(msg, `Please fill in: ${missing.join(", ")}.`, "error"); return; }

    const btn = $("#ev-pay");
    btn.disabled = true;
    note(msg, "Starting payment…", "info");
    const { data, error } = await sb.functions.invoke("event-checkout", {
      body: { event: eventId, full_name: value("#ev-name"), phone: value("#ev-phone"), email: value("#ev-email"),
              moto_type: value("#ev-type"), moto_model: value("#ev-model"), shirt_size: size,
              interests: [...form.querySelectorAll("input[name=ev-interest]:checked")].map((c) => c.value) },
    });
    if (error || !data?.url) {
      let text = "Could not start the payment. Please try again.";
      try { const body = await error?.context?.json(); if (body?.error) text = body.error; } catch { /* keep default */ }
      btn.disabled = false;
      note(msg, text, "error");
      load();
      return;
    }
    if (data.ticket) store.set(`vcm-ticket-${eventId}`, data.ticket);
    location.href = data.url;
  });

  load();
})();
