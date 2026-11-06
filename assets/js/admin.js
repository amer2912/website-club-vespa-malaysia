/* =========================================================
   Vespa Club Malaysia: AJK admin (ahli/admin.html)
   Member list, search, CSV export and manual payments.
   Access is enforced by the database (public.admins),
   not by this page.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rm = (cents) => `RM${(cents / 100).toFixed(2)}`;
  const todayMYT = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const yearMYT = () => Number(todayMYT().slice(0, 4));
  const fmtDate = (d) => {
    if (!d) return "—";
    const date = d.length === 10 ? new Date(`${d}T00:00:00+08:00`) : new Date(d);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
  };
  const statusOf = (m) => (!m.expires_on ? "new" : m.expires_on >= todayMYT() ? "active" : "expired");
  const LABEL = { active: "Active", expired: "Expired", new: "Never paid" };
  const note = (el, text, kind = "info") => { el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const view = (id) => ["adm-loading", "adm-denied", "adm-main"].forEach((v) => { $(`#${v}`).hidden = v !== id; });

  const deny = (title, text) => { $("#adm-denied-title").textContent = title; $("#adm-denied-text").textContent = text; view("adm-denied"); };

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) {
    deny("Not set up yet", "The member system has not been connected yet. See docs/SETUP-KEAHLIAN.md in the website repository.");
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let members = [];
  let current = null;

  async function init() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { deny("Please log in", "Log in on the member portal with your AJK email first."); return; }
    const { data: isAdmin } = await sb.rpc("is_admin");
    if (isAdmin !== true) { deny("Admins only", "Your account does not have AJK admin access. Ask the club secretary to add your email to the admins list."); return; }
    view("adm-main");
    await Promise.all([loadMembers(), loadPayments()]);
  }

  async function loadMembers() {
    const { data, error } = await sb.from("members").select("*").order("member_no", { ascending: true, nullsFirst: false });
    if (error) { note($("#adm-msg"), `Could not load members: ${error.message}`, "error"); return; }
    members = data || [];
    renderStats();
    renderRows();
  }

  async function loadPayments() {
    const { data } = await sb.from("payments")
      .select("coverage_year, amount_cents, method, status, paid_at, recorded_by, members(full_name, member_no)")
      .eq("status", "paid").order("paid_at", { ascending: false }).limit(20);
    $("#adm-payments").innerHTML = (data || []).length
      ? data.map((p) => `<li><div><strong>${esc(p.members?.full_name || "—")}</strong> <span class="muted">${esc(p.members?.member_no || "")}</span>
          <div class="muted">${esc(fmtDate(p.paid_at))} · ${p.method === "fpx" ? "FPX" : p.method === "cash" ? "Cash" : "Transfer"} · ${p.coverage_year}${p.recorded_by ? ` · by ${esc(p.recorded_by)}` : ""}</div></div>
          <strong>${rm(p.amount_cents)}</strong></li>`).join("")
      : `<li class="muted">No payments yet.</li>`;
  }

  function renderStats() {
    const count = (fn) => members.filter(fn).length;
    const stats = [
      [members.length, "Accounts"],
      [count((m) => statusOf(m) === "active"), "Active members"],
      [count((m) => statusOf(m) === "expired"), "Expired"],
      [count((m) => !m.profile_completed_at), "Profile incomplete"],
    ];
    $("#adm-stats").innerHTML = stats.map(([n, l]) => `<div><strong>${n}</strong><span>${l}</span></div>`).join("");
  }

  function filtered() {
    const q = $("#adm-search").value.trim().toLowerCase();
    const f = $("#adm-filter").value;
    return members.filter((m) => {
      if (f === "incomplete" ? m.profile_completed_at : f !== "all" && statusOf(m) !== f) return false;
      if (!q) return true;
      return [m.member_no, m.full_name, m.email, m.phone, m.plate_no, m.state, m.vespa_model]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function renderRows() {
    const rows = filtered();
    $("#adm-rows").innerHTML = rows.map((m) => {
      const st = statusOf(m);
      return `<tr>
        <td class="num">${esc(m.member_no || "—")}</td>
        <td><strong>${esc(m.full_name || "(no name yet)")}</strong>${m.profile_completed_at ? "" : '<div class="muted" style="font-size:.8rem">Profile incomplete</div>'}</td>
        <td><div>${esc(m.email)}</div><div class="muted">${esc(m.phone || "")}</div></td>
        <td>${esc(m.state || "—")}</td>
        <td>${esc(m.vespa_model || "—")}<div class="muted">${esc(m.plate_no || "")}</div></td>
        <td class="num">${esc(fmtDate(m.expires_on))}</td>
        <td><span class="pill pill--${st}">${LABEL[st]}</span></td>
        <td><button class="btn btn--line btn--small" type="button" data-pay="${esc(m.id)}">Record payment</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="muted">No members match.</td></tr>`;
    $("#adm-count").textContent = `Showing ${rows.length} of ${members.length}`;
  }

  $("#adm-search").addEventListener("input", renderRows);
  $("#adm-filter").addEventListener("change", renderRows);

  /* ---------- CSV export ---------- */
  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  $("#adm-export").addEventListener("click", () => {
    const cols = ["member_no", "full_name", "email", "phone", "state", "vespa_model", "plate_no", "expires_on", "joined_on"];
    const lines = [[...cols, "status"].join(",")].concat(
      filtered().map((m) => [...cols.map((c) => csvCell(m[c])), LABEL[statusOf(m)]].join(","))
    );
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vcm-members-${todayMYT()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  /* ---------- manual payment ---------- */
  const dialog = $("#pay-dialog");
  $("#adm-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pay]");
    if (!btn) return;
    current = members.find((m) => m.id === btn.dataset.pay);
    if (!current) return;
    const nextYear = current.expires_on && Number(current.expires_on.slice(0, 4)) >= yearMYT() ? Number(current.expires_on.slice(0, 4)) + 1 : yearMYT();
    $("#pay-member").textContent = `${current.full_name || current.email} (${current.member_no || "new"})`;
    $("#pay-year").value = nextYear;
    $("#pay-amount").value = "50.00";
    $("#pay-method").value = "cash";
    $("#pay-note").value = "";
    note($("#pay-msg"), "");
    dialog.showModal();
  });
  $("#pay-cancel").addEventListener("click", () => dialog.close());

  $("#pay-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const year = Number($("#pay-year").value);
    const cents = Math.round(Number($("#pay-amount").value) * 100);
    if (!(year >= 2019 && year <= 2100) || !(cents > 0)) { note($("#pay-msg"), "Check the year and amount.", "error"); return; }
    const btn = e.submitter || $("#pay-form button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.rpc("admin_record_payment", {
      p_member_id: current.id, p_coverage_year: year, p_amount_cents: cents,
      p_method: $("#pay-method").value, p_note: $("#pay-note").value.trim() || null,
    });
    btn.disabled = false;
    if (error) { note($("#pay-msg"), `Could not save: ${error.message}`, "error"); return; }
    dialog.close();
    note($("#adm-msg"), `Payment saved for ${current.full_name || current.email}.`, "success");
    await Promise.all([loadMembers(), loadPayments()]);
  });

  init();
})();
