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
  // "VCM0442", "vcm-442" and "VCM-0442" are the same member number
  const sameNo = (a, b) => String(a || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^VCM0*/, "VCM")
    === String(b || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^VCM0*/, "VCM");
  const LABEL = { active: "Active", expired: "Expired", new: "Never paid" };
  const METHOD = { fpx: "FPX", cash: "Cash", transfer: "Transfer", legacy: "Old Google Form" };
  const orNull = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : t; };
  const note = (el, text, kind = "info") => { el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const view = (id) => ["adm-loading", "adm-denied", "adm-main"].forEach((v) => { $(`#${v}`).hidden = v !== id; });

  const deny = (title, text) => { $("#adm-denied-title").textContent = title; $("#adm-denied-text").textContent = text; view("adm-denied"); };

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) {
    deny("Not set up yet", "The member system has not been connected yet. See docs/SETUP-KEAHLIAN.md in the website repository.");
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let members = [];
  let imports = [];
  let paidYears = new Map();
  let vwc = new Map();   // VCM member no. -> VWC no. (SQL 016)
  let fees = { new_member_fee_cents: 13000, fee_cents: 6000 };
  let current = null;
  let editing = null;

  // 'editor', 'viewer' or null. Falls back to is_admin() until 007 is run.
  async function adminRole() {
    const r = await sb.rpc("my_admin_role");
    if (!r.error) return r.data || null;
    const a = await sb.rpc("is_admin");
    return a.data === true ? "editor" : null;
  }

  async function init() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { deny("Please log in", "Log in on the member portal with your AJK email first."); return; }
    const role = await adminRole();
    if (!role) { deny("Admins only", "Your account does not have AJK admin access. Ask the club secretary to add your email to the admins list."); return; }
    view("adm-main");
    if (role === "viewer") {
      document.body.classList.add("is-viewer");
      note($("#adm-msg"), "View-only access: you can see and export the list, but changes are made by AJK editors.", "info");
    }
    const { data: feeRow } = await sb.from("settings").select("*").maybeSingle();
    if (feeRow?.fee_cents) fees = { ...fees, ...feeRow };
    await Promise.all([loadMembers(), loadPayments()]);
    await loadImports();
  }

  async function loadMembers() {
    const [{ data, error }, paid] = await Promise.all([
      sb.from("members").select("*").order("member_no", { ascending: true, nullsFirst: false }),
      sb.from("payments").select("member_id, coverage_year, kind, method").eq("status", "paid"),
      sb.from("vwc_numbers").select("member_no, vwc_no"),
    ]).then(([a, b, c]) => { vwc = new Map((c.data || []).map((r) => [r.member_no, r.vwc_no])); return [a, b]; });
    if (error) { note($("#adm-msg"), `Could not load members: ${error.message}`, "error"); return; }
    members = data || [];
    // member id -> { year: "new" | "renewal" } from paid payments (portal, cash, transfer, old Google Form)
    paidYears = new Map();
    (paid.data || []).forEach((p) => {
      if (!paidYears.has(p.member_id)) paidYears.set(p.member_id, {});
      const y = paidYears.get(p.member_id);
      if (!y[p.coverage_year] || p.kind === "new") y[p.coverage_year] = p.kind === "new" ? "new" : "renewal";
    });
    fillYears();
    renderStats();
    renderRows();
  }

  // Membership years for a member: years with a paid payment, plus the year of
  // their "valid until" date when no payment is recorded for it (members who
  // paid before the portal, through the old Google Form).
  function yearsOf(m) {
    const y = { ...(paidYears.get(m.id) || {}) };
    const until = m.expires_on ? Number(m.expires_on.slice(0, 4)) : null;
    if (until && !y[until]) y[until] = "legacy";
    return y;
  }
  const KIND = { new: "New member", renewal: "Renewal", legacy: "Before portal" };
  function fillYears() {
    const sel = $("#adm-year");
    const keep = sel.value;
    let max = yearMYT() + 1;
    members.forEach((m) => Object.keys(yearsOf(m)).forEach((y) => { max = Math.max(max, Number(y)); }));
    const opts = ['<option value="all">All years</option>'];
    for (let y = max; y >= 2019; y--) opts.push(`<option value="${y}">${y}</option>`);
    sel.innerHTML = opts.join("");
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "all";
  }

  async function loadPayments() {
    const { data } = await sb.from("payments")
      .select("*, members(full_name, member_no)")
      .eq("status", "paid").order("paid_at", { ascending: false }).limit(20);
    $("#adm-payments").innerHTML = (data || []).length
      ? data.map((p) => `<li><div><strong>${esc(p.members?.full_name || "—")}</strong> <span class="muted">${esc(p.members?.member_no || "")}</span>
          <div class="muted">${esc(fmtDate(p.paid_at))} · ${METHOD[p.method] || esc(p.method)}${p.kind === "new" ? " · New member" : ""} · ${p.coverage_year}${p.recorded_by ? ` · by ${esc(p.recorded_by)}` : ""}</div></div>
          <strong>${p.amount_cents ? rm(p.amount_cents) : "—"}</strong></li>`).join("")
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
    const year = $("#adm-year").value;
    const kind = $("#adm-kind").value;
    return members.filter((m) => {
      const st = statusOf(m);
      if (f === "incomplete" ? m.profile_completed_at : f === "inactive" ? st === "active" : f !== "all" && st !== f) return false;
      if (year !== "all" || kind !== "all") {
        const ys = yearsOf(m);
        if (year !== "all") {
          if (!ys[year]) return false;
          if (kind !== "all" && ys[year] !== kind) return false;
        } else if (!Object.values(ys).includes(kind)) return false;
      }
      if (!q) return true;
      return [m.member_no, m.claimed_member_no, m.full_name, m.email, m.phone, m.plate_no, m.state, m.vespa_model, m.nric, vwc.get(m.member_no)]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  // Under the status pill: how the member joined for the selected year (or their latest year).
  function typeNote(m) {
    const ys = yearsOf(m);
    const year = $("#adm-year").value;
    const y = year !== "all" ? year : Object.keys(ys).sort().pop();
    return y && ys[y] ? `<div class="muted" style="font-size:.78rem;margin-top:4px">${esc(KIND[ys[y]])} · ${esc(y)}</div>` : "";
  }

  function renderRows() {
    const rows = filtered();
    $("#adm-rows").innerHTML = rows.map((m) => {
      const st = statusOf(m);
      return `<tr>
        <td class="num">${esc(m.member_no || "—")}${m.claimed_member_no && !sameNo(m.claimed_member_no, m.member_no)
          ? `<div class="claimed" title="Number typed by the member, for checking">claims ${esc(m.claimed_member_no)}</div>` : ""}${vwc.get(m.member_no)
          ? `<div class="muted" style="font-size:.78rem" title="Vespa World Club no.">VWC ${esc(vwc.get(m.member_no))}</div>` : ""}</td>
        <td><strong>${esc(m.full_name || "(no name yet)")}</strong>${m.profile_completed_at ? "" : '<div class="muted" style="font-size:.8rem">Profile incomplete</div>'}</td>
        <td><div>${esc(m.email)}</div><div class="muted">${esc(m.phone || "")}</div></td>
        <td>${esc(m.state || "—")}</td>
        <td>${esc(m.vespa_model || "—")}<div class="muted">${esc(m.plate_no || "")}</div></td>
        <td class="num">${esc(fmtDate(m.expires_on))}</td>
        <td><span class="pill pill--${st}">${LABEL[st]}</span>${typeNote(m)}</td>
        <td><div class="form-actions" style="flex-wrap:nowrap">
          <button class="btn btn--line btn--small" type="button" data-edit="${esc(m.id)}">Edit</button>
          <button class="btn btn--line btn--small" type="button" data-pay="${esc(m.id)}">Payment</button>
        </div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="muted">No members match.</td></tr>`;
    const year = $("#adm-year").value;
    let summary = `Showing ${rows.length} of ${members.length}`;
    if (year !== "all") {
      const tally = { new: 0, renewal: 0, legacy: 0 };
      rows.forEach((m) => { const k = yearsOf(m)[year]; if (k) tally[k]++; });
      summary += ` · ${year}: ${tally.new} new, ${tally.renewal} renewal${tally.legacy ? `, ${tally.legacy} before portal` : ""}`;
    }
    $("#adm-count").textContent = summary;
  }

  $("#adm-search").addEventListener("input", renderRows);
  $("#adm-filter").addEventListener("change", renderRows);
  $("#adm-year").addEventListener("change", renderRows);
  $("#adm-kind").addEventListener("change", renderRows);

  /* ---------- CSV export ---------- */
  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  $("#adm-export").addEventListener("click", () => {
    const cols = ["member_no", "claimed_member_no", "full_name", "nationality", "nric", "gender", "age", "email", "phone",
      "address", "state", "beneficiary_name", "beneficiary_nric", "beneficiary_relation", "oku",
      "vespa_model", "plate_no", "tshirt_size", "club_group", "remark", "expires_on", "joined_on", "declaration_accepted_at"];
    const yearSel = $("#adm-year").value;
    const typeFor = (m) => { const ys = yearsOf(m); const y = yearSel !== "all" ? yearSel : Object.keys(ys).sort().pop(); return y && ys[y] ? `${KIND[ys[y]]} ${y}` : ""; };
    const lines = [[...cols, "status", "membership_type", "vwc_no"].join(",")].concat(
      filtered().map((m) => [...cols.map((c) => csvCell(m[c])), LABEL[statusOf(m)], csvCell(typeFor(m)), csvCell(vwc.get(m.member_no))].join(","))
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
    // Active members pay the year after their expiry. New members who join once
    // next year's renewal is open (November by default) pay for next year.
    const opensMonth = Number(fees.renewal_opens_month) || 11;
    const lateInYear = Number(todayMYT().slice(5, 7)) >= opensMonth;
    const nextYear = current.expires_on && Number(current.expires_on.slice(0, 4)) >= yearMYT() ? Number(current.expires_on.slice(0, 4)) + 1
      : !current.member_no && !current.expires_on && lateInYear ? yearMYT() + 1 : yearMYT();
    $("#pay-member").textContent = `${current.full_name || current.email} (${current.member_no || "new"})`;
    $("#pay-year").value = nextYear;
    const isNew = !current.member_no && !current.expires_on;
    $("#pay-amount").value = ((isNew ? fees.new_member_fee_cents : fees.fee_cents) / 100).toFixed(2);
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
    const method = $("#pay-method").value;
    const amountOk = cents > 0 || (method === "legacy" && cents === 0);
    if (!(year >= 2019 && year <= 2100) || !amountOk) { note($("#pay-msg"), "Check the year and amount.", "error"); return; }
    const btn = e.submitter || $("#pay-form button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.rpc("admin_record_payment", {
      p_member_id: current.id, p_coverage_year: year, p_amount_cents: cents,
      p_method: method, p_note: $("#pay-note").value.trim() || null,
    });
    btn.disabled = false;
    if (error) { note($("#pay-msg"), `Could not save: ${error.message}`, "error"); return; }
    dialog.close();
    note($("#adm-msg"), `Payment saved for ${current.full_name || current.email}.`, "success");
    await Promise.all([loadMembers(), loadPayments()]);
    await loadImports();
  });

  /* ---------- edit member ---------- */
  const editDialog = $("#edit-dialog");
  const ED = ["member_no", "full_name", "phone", "state", "vespa_model", "plate_no", "expires_on"];
  $("#adm-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit]");
    if (!btn) return;
    editing = members.find((m) => m.id === btn.dataset.edit);
    if (!editing) return;
    ED.forEach((f) => { $(`#ed-${f}`).value = editing[f] ?? ""; });
    $("#ed-vwc").value = vwc.get(editing.member_no) || "";
    $("#edit-email").textContent = editing.email;
    note($("#edit-msg"), "");
    editDialog.showModal();
  });
  $("#edit-cancel").addEventListener("click", () => editDialog.close());
  $("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(ED.map((f) => [f, orNull($(`#ed-${f}`).value)]));
    if (v.phone && !/^\+?[0-9][0-9 -]{7,18}$/.test(v.phone)) { note($("#edit-msg"), "Please enter a valid phone number.", "error"); return; }
    const btn = e.submitter || $("#edit-form button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.rpc("admin_update_member", {
      p_member_id: editing.id, p_member_no: v.member_no, p_full_name: v.full_name, p_phone: v.phone,
      p_state: v.state, p_vespa_model: v.vespa_model, p_plate_no: v.plate_no, p_expires_on: v.expires_on,
    });
    btn.disabled = false;
    if (error) {
      // The number belongs to a pre-registration made with another email (old Google Form):
      // offer to move that pre-registration onto this account.
      const m = error.message.match(/reserved for (\S+@\S+) in the pre-registered list/);
      if (!m) { note($("#edit-msg"), error.message, "error"); return; }
      const box = $("#edit-msg");
      box.className = "notice notice--warn"; box.hidden = false;
      box.innerHTML = `${esc(error.message)}.<br>If this is the same person (old Google Form email), link it to this account: the member number and paid-until date move here and the pre-registration is removed.
        <br><button type="button" class="btn btn--small" id="edit-link" style="margin-top:10px">Link pre-registration to this account</button>`;
      $("#edit-link").addEventListener("click", async () => {
        const linkBtn = $("#edit-link"); linkBtn.disabled = true;
        const { error: linkError } = await sb.rpc("admin_link_import", { p_member_id: editing.id, p_email: m[1] });
        if (linkError) { linkBtn.disabled = false; note(box, linkError.message, "error"); return; }
        // Save the rest of the form now that the number is free.
        const { error: saveError } = await sb.rpc("admin_update_member", {
          p_member_id: editing.id, p_member_no: v.member_no, p_full_name: v.full_name, p_phone: v.phone,
          p_state: v.state, p_vespa_model: v.vespa_model, p_plate_no: v.plate_no, p_expires_on: v.expires_on,
        });
        if (saveError) { note(box, `Linked, but could not save the other changes: ${saveError.message}`, "error"); await loadMembers(); await loadImports(); return; }
        editDialog.close();
        note($("#adm-msg"), `Linked ${m[1]} to ${v.full_name || editing.email} and saved.`, "success");
        await loadMembers(); await loadImports();
      });
      return;
    }
    const vwcErr = await saveVwc(v.member_no);
    if (vwcErr) { note($("#edit-msg"), `Member saved, but the VWC number was not: ${vwcErr}`, "error"); await loadMembers(); return; }
    editDialog.close();
    note($("#adm-msg"), `Saved changes for ${v.full_name || editing.email}.`, "success");
    await loadMembers();
  });

  /* ---------- Vespa World Club numbers ---------- */
  const normVwc = (s) => String(s || "").toUpperCase().replace(/[\s-]/g, "");
  // Saves the edit dialog's VWC field when it changed. Returns an error message or null.
  async function saveVwc(memberNo) {
    const typed = normVwc($("#ed-vwc").value);
    const before = vwc.get(editing.member_no) || "";
    if (typed === before && memberNo === editing.member_no) return null;
    if (!typed && !before) return null;
    if (!memberNo) return "give the member a VCM number first.";
    const { error } = await sb.rpc("admin_set_vwc_no", { p_member_no: memberNo, p_vwc_no: typed });
    return error ? error.message : null;
  }
  // Pasted from Google Sheets: tab-separated columns. Take the VCM number and the MY number from each line.
  function parseVwc(text) {
    const rows = [], skipped = [];
    String(text || "").split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const cells = line.split(/\t|,|;/).map((c) => c.trim().toUpperCase());
      const vwcNo = cells.map(normVwc).find((c) => /^MY\d{4,10}$/.test(c));
      // Prefer a cell that says VCM; a bare number is used only when no cell does.
      const vcm = cells.map((c) => c.match(/^VCM[\s-]*0*(\d{1,4})$/)).find(Boolean)
        || cells.map((c) => c.match(/^0*(\d{1,4})$/)).filter(Boolean).pop();
      if (vwcNo && vcm) rows.push({ member_no: `VCM-${vcm[1].padStart(4, "0")}`, vwc_no: vwcNo });
      else skipped.push(line.trim().slice(0, 40));
    });
    return { rows, skipped };
  }
  $("#vwc-paste").addEventListener("input", () => {
    const { rows, skipped } = parseVwc($("#vwc-paste").value);
    $("#vwc-preview").textContent = rows.length || skipped.length
      ? `${rows.length} rows ready${rows.length ? ` (e.g. ${rows.slice(0, 2).map((r) => `${r.member_no} → ${r.vwc_no}`).join(", ")})` : ""}${skipped.length ? ` · ${skipped.length} lines without both numbers (headings are fine)` : ""}`
      : "";
  });
  $("#vwc-import").addEventListener("click", async () => {
    const { rows } = parseVwc($("#vwc-paste").value);
    if (!rows.length) { note($("#vwc-msg"), "No rows with both a VCM number and an MY number found.", "error"); return; }
    const btn = $("#vwc-import"); btn.disabled = true;
    const { data, error } = await sb.rpc("admin_import_vwc", { p_rows: rows });
    btn.disabled = false;
    if (error) { note($("#vwc-msg"), error.message, "error"); return; }
    const r = Array.isArray(data) ? data[0] : data;
    const problems = r?.problems || [];
    const box = $("#vwc-msg");
    box.className = `notice notice--${problems.length ? "warn" : "success"}`; box.hidden = false;
    box.innerHTML = `Saved ${esc(r?.saved ?? 0)}, already up to date ${esc(r?.unchanged ?? 0)}.${problems.length
      ? `<br>Not saved (${problems.length}):<ul style="margin:6px 0 0 18px">${problems.slice(0, 30).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}`;
    if (!problems.length) { $("#vwc-paste").value = ""; $("#vwc-preview").textContent = ""; }
    await loadMembers();
  });

  /* ---------- pre-registered members (not logged in yet) ---------- */
  async function loadImports() {
    const { data, error } = await sb.from("member_import").select("*").order("member_no", { ascending: true, nullsFirst: false });
    if (error) { $("#pre-rows").innerHTML = `<tr><td colspan="6" class="muted">Could not load: ${esc(error.message)}</td></tr>`; return; }
    const withAccount = new Set(members.map((m) => m.email));
    imports = (data || []).filter((r) => !withAccount.has(r.email));
    $("#pre-rows").innerHTML = imports.map((r) => `<tr>
        <td>${esc(r.email)}</td>
        <td class="num">${esc(r.member_no || "—")}</td>
        <td>${esc(r.full_name || "—")}</td>
        <td>${esc(r.phone || "—")}</td>
        <td class="num">${esc(fmtDate(r.expires_on))}</td>
        <td><div class="form-actions" style="flex-wrap:nowrap">
          <button class="btn btn--line btn--small" type="button" data-pre-edit="${esc(r.email)}">Edit</button>
          <button class="text-btn" type="button" data-pre-del="${esc(r.email)}">Remove</button>
        </div></td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted">No pre-registered members waiting to log in.</td></tr>`;
  }

  const preDialog = $("#pre-dialog");
  const PRE = ["email", "member_no", "full_name", "phone", "expires_on"];
  let preOriginalEmail = null;
  function openPre(row) {
    PRE.forEach((f) => { $(`#pre-${f}`).value = row?.[f] ?? ""; });
    preOriginalEmail = row ? row.email : null;  // the email can be corrected before they log in
    $("#pre-title").textContent = row ? "Edit pre-registered member" : "Add member";
    note($("#pre-msg"), "");
    preDialog.showModal();
  }
  $("#pre-add").addEventListener("click", () => openPre(null));
  $("#pre-cancel").addEventListener("click", () => preDialog.close());
  $("#pre-rows").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-pre-edit]");
    if (ed) { openPre(imports.find((r) => r.email === ed.dataset.preEdit)); return; }
    const del = e.target.closest("[data-pre-del]");
    if (!del) return;
    if (!window.confirm(`Remove ${del.dataset.preDel} from the pre-registered list?`)) return;
    const { error } = await sb.rpc("admin_delete_import", { p_email: del.dataset.preDel });
    note($("#adm-msg"), error ? `Could not remove: ${error.message}` : `Removed ${del.dataset.preDel}.`, error ? "error" : "success");
    await loadImports();
  });
  $("#pre-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(PRE.map((f) => [f, orNull($(`#pre-${f}`).value)]));
    if (!v.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) { note($("#pre-msg"), "Please enter a valid email address.", "error"); return; }
    if (v.phone && !/^\+?[0-9][0-9 -]{7,18}$/.test(v.phone)) { note($("#pre-msg"), "Please enter a valid phone number.", "error"); return; }
    const btn = e.submitter || $("#pre-form button[type=submit]");
    btn.disabled = true;
    if (preOriginalEmail && v.email.toLowerCase() !== preOriginalEmail) {
      const { error: mvError } = await sb.rpc("admin_change_import_email", { p_old: preOriginalEmail, p_new: v.email });
      if (mvError) { btn.disabled = false; note($("#pre-msg"), mvError.message, "error"); return; }
      preOriginalEmail = v.email.toLowerCase();
    }
    const { error } = await sb.rpc("admin_upsert_import", {
      p_email: v.email, p_member_no: v.member_no, p_full_name: v.full_name, p_phone: v.phone, p_expires_on: v.expires_on,
    });
    btn.disabled = false;
    if (error) { note($("#pre-msg"), error.message, "error"); return; }
    preDialog.close();
    note($("#adm-msg"), `Saved ${v.email}. Their details will be copied when they first log in.`, "success");
    await loadImports();
  });

  init();
})();
