/* =========================================================
   Vespa Club Malaysia: member portal (ahli/index.html)
   Login by email code or link, mandatory profile, digital
   membership card and FPX renewal through ToyyibPay.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const VIEWS = ["setup", "loading", "login", "profile", "dashboard"];

  const show = (name) => {
    VIEWS.forEach((v) => { const el = $(`#view-${v}`); if (el) el.hidden = v !== name; });
    window.scrollTo(0, 0);
  };
  const note = (el, text, kind = "info") => {
    if (!el) return;
    el.textContent = text || "";
    el.className = `notice notice--${kind}`;
    el.hidden = !text;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rm = (cents) => `RM${(cents / 100).toFixed(2)}`;
  const todayMYT = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const fmtDate = (d) => {
    if (!d) return "—";
    const date = d.length === 10 ? new Date(`${d}T00:00:00+08:00`) : new Date(d);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
  };
  const statusOf = (m) => {
    if (!m.expires_on) return { key: "new", label: "Not active yet" };
    return m.expires_on >= todayMYT() ? { key: "active", label: "Active" } : { key: "expired", label: "Expired" };
  };
  const busy = (btn, on, text) => {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.textContent = text; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  };

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) {
    show("setup");
    return;
  }

  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let member = null;
  let pendingEmail = "";
  let paymentResult = null;

  /* ---------------- routing ---------------- */
  let routing = null;
  let rerun = false;
  const requestRoute = () => {
    if (routing) { rerun = true; return; }
    routing = route().finally(() => {
      routing = null;
      if (rerun) { rerun = false; requestRoute(); }
    });
  };

  async function route() {
    const { data } = await sb.auth.getSession();
    const session = data.session;
    if (!session) { showLogin(); return; }

    show("loading");
    const { data: m, error } = await sb.from("members").select("*").eq("id", session.user.id).single();
    if (error || !m) {
      showLogin();
      note($("#login-msg"), "We could not load your membership record. Please try again, or contact the AJK if this keeps happening.", "error");
      return;
    }
    member = m;
    await handlePaymentReturn();
    if (!member.profile_completed_at) openProfile(true);
    else await openDashboard();
  }

  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") setTimeout(requestRoute, 0);
  });

  /* ---------------- login ---------------- */
  function showLogin() {
    $("#login-step-email").hidden = false;
    $("#login-step-code").hidden = true;
    show("login");
  }

  let cooldownTimer = null;
  function startCooldown(seconds = 60) {
    const btn = $("#resend-code");
    clearInterval(cooldownTimer);
    let left = seconds;
    btn.disabled = true;
    btn.textContent = `Resend code in ${left}s`;
    cooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(cooldownTimer); btn.disabled = false; btn.textContent = "Resend code"; }
      else btn.textContent = `Resend code in ${left}s`;
    }, 1000);
  }

  async function sendCode(email) {
    return sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}${location.pathname}`, shouldCreateUser: true },
    });
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#login-msg");
    const email = $("#login-email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      $("#login-email").setAttribute("aria-invalid", "true");
      note(msg, "Please enter a valid email address.", "error");
      return;
    }
    $("#login-email").removeAttribute("aria-invalid");
    const btn = e.submitter || $("#login-form button[type=submit]");
    busy(btn, true, "Sending…");
    const { error } = await sendCode(email);
    busy(btn, false);
    if (error) {
      note(msg, /rate|security purposes|seconds/i.test(error.message)
        ? "Too many requests. Please wait a minute and try again."
        : `Could not send the email: ${error.message}`, "error");
      return;
    }
    pendingEmail = email;
    note(msg, "");
    $("#code-email").textContent = email;
    $("#login-step-email").hidden = true;
    $("#login-step-code").hidden = false;
    $("#login-code").value = "";
    $("#login-code").focus();
    startCooldown();
  });

  $("#code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#code-msg");
    const token = $("#login-code").value.replace(/\D/g, "");
    if (token.length < 6) { note(msg, "Enter the code from the email.", "error"); return; }
    const btn = e.submitter || $("#code-form button[type=submit]");
    busy(btn, true, "Checking…");
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
    busy(btn, false);
    if (error) { note(msg, "That code is wrong or has expired. Check the latest email, or send a new code.", "error"); return; }
    note(msg, "");
    requestRoute();
  });

  $("#resend-code").addEventListener("click", async () => {
    const { error } = await sendCode(pendingEmail);
    note($("#code-msg"), error ? "Please wait a minute before asking for another code." : "A new code is on its way.", error ? "error" : "success");
    if (!error) startCooldown();
  });
  $("#change-email").addEventListener("click", () => { note($("#code-msg"), ""); showLogin(); $("#login-email").focus(); });

  /* ---------------- profile ---------------- */
  const PROFILE_FIELDS = ["full_name", "phone", "state", "vespa_model", "plate_no"];

  function openProfile(required) {
    PROFILE_FIELDS.forEach((f) => { $(`#pf-${f}`).value = member[f] ?? ""; $(`#pf-${f}`).removeAttribute("aria-invalid"); });
    $("#pf-email").textContent = member.email;
    $("#profile-required").hidden = !required;
    $("#profile-cancel").hidden = required;
    note($("#profile-msg"), "");
    show("profile");
  }

  function validateProfile(values) {
    const problems = [];
    const mark = (f, bad) => $(`#pf-${f}`).setAttribute("aria-invalid", bad ? "true" : "false");
    const nameBad = values.full_name.length < 3; mark("full_name", nameBad); if (nameBad) problems.push("full name");
    const phoneBad = !/^\+?[0-9][0-9 -]{7,18}$/.test(values.phone); mark("phone", phoneBad); if (phoneBad) problems.push("phone number (e.g. 012-345 6789)");
    const stateBad = !values.state; mark("state", stateBad); if (stateBad) problems.push("state");
    const modelBad = !values.vespa_model; mark("vespa_model", modelBad); if (modelBad) problems.push("Vespa model");
    return problems;
  }

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#profile-msg");
    const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(`#pf-${f}`).value.trim()]));
    const problems = validateProfile(values);
    if (problems.length) { note(msg, `Please check your ${problems.join(", ")}.`, "error"); return; }
    const btn = e.submitter || $("#profile-form button[type=submit]");
    busy(btn, true, "Saving…");
    const { data, error } = await sb.from("members").update(values).eq("id", member.id).select().single();
    busy(btn, false);
    if (error) {
      note(msg, /phone/i.test(error.message) ? "Please enter a valid phone number." : `Could not save your profile: ${error.message}`, "error");
      return;
    }
    member = data;
    await openDashboard("Profile saved.");
  });
  $("#profile-cancel").addEventListener("click", () => openDashboard());

  /* ---------------- payment return from ToyyibPay ---------------- */
  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    if (params.get("payment") !== "return") return;
    const billcode = params.get("billcode") || "";
    history.replaceState(null, "", location.pathname);
    if (!/^[A-Za-z0-9]{4,32}$/.test(billcode)) return;

    const { data } = await sb.functions.invoke("toyyibpay-callback", { body: { billcode } });
    const { data: fresh } = await sb.from("members").select("*").eq("id", member.id).single();
    if (fresh) member = fresh;
    const status = data?.status || (params.get("status_id") === "3" ? "failed" : "pending");
    paymentResult = {
      paid: ["success", `Payment received. Thank you! Your membership is active until ${fmtDate(member.expires_on)}.`],
      failed: ["error", "The payment was not completed. No money was taken. You can try again below."],
      pending: ["warn", "Your payment is still being confirmed by the bank. Refresh this page in a few minutes."],
    }[status] || null;
  }

  /* ---------------- dashboard ---------------- */
  async function openDashboard(flash) {
    const st = statusOf(member);
    $("#card-name").textContent = member.full_name || member.email;
    $("#card-no").textContent = member.member_no || "Given after first payment";
    $("#card-until").textContent = member.expires_on ? fmtDate(member.expires_on) : "—";
    $("#card-status").className = `pill pill--${st.key}`;
    $("#card-status").textContent = st.label;
    $("#dash-greeting").textContent = `Hi, ${(member.full_name || "").split(" ")[0] || "member"}`;

    $("#profile-summary").innerHTML = [
      ["Email", member.email], ["Phone", member.phone], ["State", member.state],
      ["Vespa", member.vespa_model], ["Plate no.", member.plate_no || "—"], ["Member since", fmtDate(member.joined_on)],
    ].map(([k, v]) => `<li><span>${esc(k)}</span><strong>${esc(v)}</strong></li>`).join("");

    const flashEl = $("#dash-msg");
    if (paymentResult) { note(flashEl, paymentResult[1], paymentResult[0]); paymentResult = null; }
    else if (flash) note(flashEl, flash, "success");
    else note(flashEl, "");

    show("dashboard");
    await Promise.all([loadQuote(), loadPayments(), loadAdminLink()]);
  }

  async function loadQuote() {
    const box = $("#renew-box");
    const { data, error } = await sb.rpc("renewal_quote");
    const q = Array.isArray(data) ? data[0] : data;
    const opts = {
      new: { box: $("#opt-new"), btn: $("#pay-new"), note: $("#note-new"), price: $("#price-new") },
      renewal: { box: $("#opt-renewal"), btn: $("#pay-renewal"), note: $("#note-renewal"), price: $("#price-renewal") },
    };
    if (error || !q) {
      $("#renew-text").textContent = "Membership fees are not available right now. Please try again later.";
      Object.values(opts).forEach((o) => { o.btn.disabled = true; });
      box.hidden = false;
      return;
    }
    opts.new.price.textContent = q.new_fee_cents ? rm(q.new_fee_cents) : "";
    opts.renewal.price.textContent = q.renewal_fee_cents ? rm(q.renewal_fee_cents) : "";

    // The database decides which fee applies; the other option is shown but cannot be used.
    const mine = q.kind === "new" ? "new" : "renewal";
    const other = mine === "new" ? "renewal" : "new";
    opts.new.note.textContent = mine === "new"
      ? "For first-time members. Your member number is given after payment."
      : `For first-time members only. You are already a member${member.member_no ? ` (${member.member_no})` : ""}.`;
    opts.renewal.note.textContent = mine === "renewal"
      ? "For existing Vespa Club Malaysia members."
      : "For existing members with a VCM member number only.";
    opts[other].box.classList.add("is-off");
    opts[other].btn.disabled = true;
    opts[mine].box.classList.remove("is-off");

    if (q.allowed) {
      $("#renew-title").textContent = mine === "new" ? `Join for ${q.coverage_year}` : `Renew for ${q.coverage_year}`;
      $("#renew-text").textContent = `Valid until 31 December ${q.coverage_year}. Pay securely with FPX online banking.`;
      opts[mine].btn.disabled = false;
    } else {
      $("#renew-title").textContent = "Membership";
      $("#renew-text").textContent = q.reason || "Payment is not open right now.";
      opts[mine].btn.disabled = true;
    }
    box.hidden = false;
  }

  async function loadPayments() {
    const { data } = await sb.from("payments")
      .select("*")
      .order("created_at", { ascending: false }).limit(12);
    const rows = (data || []).filter((p) => p.status === "paid");
    const list = $("#history");
    list.innerHTML = rows.length
      ? rows.map((p) => `<li><div><strong>Membership ${p.coverage_year}</strong><div class="muted">${esc(fmtDate(p.paid_at || p.created_at))} · ${({ fpx: "FPX", cash: "Cash", transfer: "Bank transfer", legacy: "Google Form" })[p.method] || p.method}${p.kind === "new" ? " · New member" : ""}</div></div><strong>${p.amount_cents ? rm(p.amount_cents) : "Paid"}</strong></li>`).join("")
      : `<li class="muted">No payments yet.</li>`;
  }

  async function loadAdminLink() {
    const { data } = await sb.rpc("is_admin");
    $("#admin-link").hidden = data !== true;
  }

  async function startPayment(e) {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const msg = $("#renew-msg");
    busy(btn, true, "Opening FPX…");
    note(msg, "");
    // The amount is decided by the server, never by this button.
    const { data, error } = await sb.functions.invoke("create-bill", { body: {} });
    if (error || !data?.url) {
      let text = "Could not start the payment. Please try again.";
      try { const body = await error?.context?.json(); if (body?.error) text = body.error; } catch { /* keep default */ }
      busy(btn, false);
      note(msg, text, "error");
      return;
    }
    location.href = data.url;
  }
  $("#pay-new").addEventListener("click", startPayment);
  $("#pay-renewal").addEventListener("click", startPayment);

  $("#edit-profile").addEventListener("click", () => openProfile(false));
  $("#logout").addEventListener("click", async () => { await sb.auth.signOut(); member = null; showLogin(); });

  requestRoute();
})();
