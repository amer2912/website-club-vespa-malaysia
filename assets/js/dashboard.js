/* =========================================================
   Vespa Club Malaysia: AJK dashboard (ahli/dashboard.html)
   Membership at a glance: who is paid, who has not renewed,
   payments by month, members by state, and follow-up lists.
   Access is enforced by the database (public.admins),
   not by this page.
   ========================================================= */
(() => {
  const cfg = window.VCM_SUPABASE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayMYT = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const Y = Number(todayMYT().slice(0, 4));
  const MONTHS = ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ogo", "Sep", "Okt", "Nov", "Dis"];
  const MONTHS_FULL = ["Januari", "Februari", "Mac", "April", "Mei", "Jun", "Julai", "Ogos", "September", "Oktober", "November", "Disember"];
  const num = (n) => Number(n || 0).toLocaleString("en-MY");
  const rm = (cents) => `RM${(cents / 100).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => {
    if (!d) return "—";
    const [y, m, day] = d.slice(0, 10).split("-").map(Number);
    return `${day} ${MONTHS[m - 1]} ${y}`;
  };
  const endYear = (p) => (p.expires_on ? Number(p.expires_on.slice(0, 4)) : null);
  const paidFor = (p, y) => !!p.expires_on && p.expires_on >= `${y}-12-31`;
  const monthMYT = (ts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    const s = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
    return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) - 1 };
  };
  const note = (el, text, kind = "info") => { el.textContent = text || ""; el.className = `notice notice--${kind}`; el.hidden = !text; };
  const view = (id) => ["adm-loading", "adm-denied", "adm-main"].forEach((v) => { $(`#${v}`).hidden = v !== id; });
  const deny = (title, text) => { $("#adm-denied-title").textContent = title; $("#adm-denied-text").textContent = text; view("adm-denied"); };

  if (!cfg.url || !cfg.anonKey || !window.supabase?.createClient) {
    deny("Belum disediakan", "Sistem keahlian belum disambungkan. Rujuk docs/SETUP-KEAHLIAN.md dalam repository laman web.");
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  let people = [];
  let payments = [];
  let fee = 6000;

  // Supabase returns at most 1000 rows per request, so read in pages.
  async function fetchAll(make) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }

  async function init() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { deny("Sila log masuk", "Log masuk di portal ahli dengan emel AJK anda dahulu."); return; }
    const { data: isAdmin } = await sb.rpc("is_admin");
    if (isAdmin !== true) { deny("AJK sahaja", "Akaun anda tiada akses admin AJK. Minta setiausaha kelab tambah emel anda dalam senarai admin."); return; }
    view("adm-main");
    try {
      const [members, imports, pays, settings] = await Promise.all([
        fetchAll(() => sb.from("members").select("*").order("member_no", { ascending: true, nullsFirst: false })),
        fetchAll(() => sb.from("member_import").select("email, member_no, full_name, phone, expires_on").order("member_no", { ascending: true, nullsFirst: false })),
        fetchAll(() => sb.from("payments").select("member_id, coverage_year, amount_cents, kind, method, paid_at").eq("status", "paid").order("paid_at", { ascending: true })),
        sb.from("settings").select("*").maybeSingle(),
      ]);
      if (settings?.data?.fee_cents) fee = settings.data.fee_cents;
      const withAccount = new Set(members.map((m) => String(m.email || "").toLowerCase()));
      people = members.map((m) => ({ ...m, account: true }))
        .concat(imports.filter((r) => !withAccount.has(String(r.email || "").toLowerCase())).map((r) => ({ ...r, account: false })));
      payments = pays;
    } catch (err) {
      note($("#adm-msg"), `Data tidak dapat dimuatkan: ${err.message || err}`, "error");
      return;
    }
    $("#dash-asof").textContent = `Data terkini pada ${fmtDate(todayMYT())}. Termasuk ahli yang sudah didaftarkan tetapi belum log masuk portal.`;
    renderKpis();
    renderYears();
    renderMonths();
    renderStates();
    buildFilters();
    renderFollow();
  }

  /* ---------- headline numbers ---------- */
  function renderKpis() {
    const active = people.filter((p) => paidFor(p, Y));
    const notRenewed = people.filter((p) => endYear(p) === Y - 1);
    const thisYear = payments.filter((p) => Number(p.coverage_year) === Y);
    const newIds = new Set(thisYear.filter((p) => p.kind === "new").map((p) => p.member_id));
    const nextYear = people.filter((p) => paidFor(p, Y + 1));
    const preActive = active.filter((p) => !p.account).length;
    const tiles = [
      [num(active.length), `Ahli aktif ${Y}`, preActive ? `${num(preActive)} belum log masuk portal` : "Semua sudah log masuk"],
      [num(notRenewed.length), `Belum renew ${Y}`, `Bayar ${Y - 1}, belum bayar ${Y}`, `lapsed-${Y - 1}`],
      [num(newIds.size), `Ahli baharu ${Y}`, "Yuran ahli baharu dibayar"],
      [rm(thisYear.reduce((s, p) => s + (p.amount_cents || 0), 0)), `Yuran untuk ${Y}`, `Daripada ${num(thisYear.length)} bayaran`],
      [num(nextYear.length), `Sudah bayar ${Y + 1}`, "Renew awal untuk tahun depan"],
    ];
    $("#dash-kpis").innerHTML = tiles.map(([n, label, sub, list]) => list
      ? `<a href="#follow" data-list="${list}"><strong>${n}</strong><span>${esc(label)}</span><small>${esc(sub)} · lihat senarai</small></a>`
      : `<div><strong>${n}</strong><span>${esc(label)}</span><small>${esc(sub)}</small></div>`).join("");
  }

  /* ---------- chart: membership ends in year ---------- */
  function renderYears() {
    const counts = {};
    let none = 0;
    people.forEach((p) => { const y = endYear(p); if (y) counts[y] = (counts[y] || 0) + 1; else none += 1; });
    const years = Object.keys(counts).map(Number).sort((a, b) => a - b);
    if (!years.length) { $("#chart-years").innerHTML = `<p class="muted">Belum ada data.</p>`; return; }
    const max = Math.max(...years.map((y) => counts[y]));
    const cols = years.map((y) => {
      const n = counts[y];
      const past = y < Y;
      const tip = `<strong>Tamat ${y}</strong><br>${num(n)} ahli · ${past ? "sudah tamat" : "masih aktif"}<br>Tekan untuk lihat nama`;
      return `<button type="button" class="col" data-tip="${esc(tip)}" data-list="${past ? `lapsed-${y}` : `active-${y}`}" aria-label="Tamat ${y}: ${n} ahli">
          <span class="col-val">${num(n)}</span>
          <span class="seg seg--top" style="height:${(n / max) * 82}%;background:var(${past ? "--c-past" : "--c-renew"})"></span>
        </button>`;
    }).join("");
    $("#chart-years").innerHTML = `<div class="cols cols--labelled">${cols}</div>
      <div class="col-labels">${years.map((y) => `<span>${y}</span>`).join("")}</div>
      ${tableView(["Tahun tamat", "Ahli", "Status"], years.map((y) => [y, num(counts[y]), y < Y ? "Sudah tamat" : "Masih aktif"]))}`;
    $("#years-note").textContent = none ? `${num(none)} akaun belum pernah bayar tidak ditunjukkan.` : "";
  }

  /* ---------- chart: payments by month ---------- */
  function renderMonths() {
    $("#months-title").textContent = `Bayaran ikut bulan (${Y})`;
    const rows = MONTHS.map(() => ({ renewal: 0, new: 0, cents: 0 }));
    payments.forEach((p) => {
      const d = monthMYT(p.paid_at);
      if (!d || d.y !== Y) return;
      const r = rows[d.m];
      r[p.kind === "new" ? "new" : "renewal"] += 1;
      r.cents += p.amount_cents || 0;
    });
    const max = Math.max(1, ...rows.map((r) => r.renewal + r.new));
    const top = niceMax(max);
    const cols = rows.map((r, i) => {
      const total = r.renewal + r.new;
      const tip = `<strong>${MONTHS_FULL[i]} ${Y}</strong><br>${num(r.renewal)} pembaharuan · ${num(r.new)} ahli baharu<br>Jumlah ${rm(r.cents)}`;
      const segs = [["new", "--c-new"], ["renewal", "--c-renew"]].filter(([k]) => r[k] > 0)
        .map(([k, c], idx) => `<span class="seg${idx === 0 ? " seg--top" : ""}" style="height:${(r[k] / top) * 100}%;background:var(${c})"></span>`).join("");
      return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${MONTHS_FULL[i]}: ${total} bayaran">${segs}</div>`;
    }).join("");
    $("#chart-months").innerHTML = `<div class="axis-wrap">
        <div class="axis" aria-hidden="true"><span>${num(top)}</span><span>${num(top / 2)}</span><span>0</span></div>
        <div><div class="cols cols--grid">${cols}</div>
        <div class="col-labels">${MONTHS.map((m) => `<span>${m}</span>`).join("")}</div></div>
      </div>
      ${tableView(["Bulan", "Pembaharuan", "Ahli baharu", "Jumlah (RM)"], rows.map((r, i) => [MONTHS_FULL[i], num(r.renewal), num(r.new), rm(r.cents)]))}`;
  }
  function niceMax(n) {
    if (n <= 4) return 4;
    const step = 10 ** Math.floor(Math.log10(n));
    const top = [1, 2, 2.5, 5, 10].map((s) => s * step).find((v) => v >= n);
    return top % 2 ? top + 1 : top;
  }

  /* ---------- chart: active members by state ---------- */
  function renderStates() {
    $("#states-title").textContent = `Ahli aktif ${Y} ikut negeri`;
    const counts = {};
    people.filter((p) => paidFor(p, Y)).forEach((p) => {
      const s = p.state || "Tiada maklumat";
      counts[s] = (counts[s] || 0) + 1;
    });
    const rows = Object.entries(counts).sort((a, b) => (a[0] === "Tiada maklumat") - (b[0] === "Tiada maklumat") || b[1] - a[1]);
    if (!rows.length) { $("#chart-states").innerHTML = `<p class="muted">Belum ada ahli aktif.</p>`; return; }
    const max = Math.max(...rows.map((r) => r[1]));
    const total = rows.reduce((s, r) => s + r[1], 0);
    $("#chart-states").innerHTML = `<div class="hbars">${rows.map(([s, n]) => `
        <div class="hbar" tabindex="0" data-tip="${esc(`<strong>${esc(s)}</strong><br>${num(n)} ahli aktif (${Math.round((n / total) * 100)}%)`)}">
          <span class="hbar-label">${esc(s)}</span>
          <span class="hbar-track"><span class="hbar-fill" style="width:${(n / max) * 100}%;background:var(${s === "Tiada maklumat" ? "--c-past" : "--c-renew"})"></span></span>
          <span class="hbar-val">${num(n)}</span>
        </div>`).join("")}</div>`;
  }

  function tableView(head, rows) {
    return `<details class="dash-table"><summary>Lihat sebagai jadual</summary>
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;
  }

  /* ---------- follow-up lists ---------- */
  const LISTS = {};
  function buildFilters() {
    const ended = [...new Set(people.map(endYear).filter((y) => y && y < Y))].sort((a, b) => b - a);
    const add = (key, label, test, msg) => { LISTS[key] = { label, test, msg }; };
    ended.forEach((y, i) => add(`lapsed-${y}`,
      i === 0 && y === Y - 1 ? `Belum renew ${Y} (terakhir bayar ${y})` : `Terakhir bayar ${y}`,
      (p) => endYear(p) === y, "renew"));
    add("prereg", "Belum log masuk portal (didaftarkan oleh AJK)", (p) => !p.account, "login");
    add("incomplete", `Ahli aktif ${Y}, profil belum lengkap`, (p) => p.account && paidFor(p, Y) && !p.profile_completed_at, "profile");
    add("nopaid", "Ada akaun tetapi belum pernah bayar", (p) => p.account && !p.expires_on, "pay");
    [...new Set(people.map(endYear).filter((y) => y && y >= Y))].sort().forEach((y) =>
      add(`active-${y}`, `Aktif, tamat ${y}`, (p) => endYear(p) === y, null));
    $("#follow-filter").innerHTML = Object.entries(LISTS)
      .map(([k, l]) => `<option value="${k}">${esc(l.label)} (${num(people.filter(l.test).length)})</option>`).join("");
  }

  const portalUrl = () => `${location.origin}/ahli/`;
  function message(kind, p) {
    const no = p.member_no ? ` (${p.member_no})` : "";
    const hi = "Salam, ini AJK Vespa Club Malaysia.";
    if (kind === "renew") return `${hi} Keahlian anda${no} telah tamat pada ${fmtDate(p.expires_on)}. Pembaharuan ${rm(fee)} kini boleh dibuat secara online di ${portalUrl()} . Terima kasih!`;
    if (kind === "login") return `${hi} Keahlian kini diurus melalui portal ahli: ${portalUrl()} . Log masuk dengan emel ${p.email} untuk lihat kad ahli${no} anda. Terima kasih!`;
    if (kind === "profile") return `${hi} Sila lengkapkan profil ahli anda${no} di ${portalUrl()} . Terima kasih!`;
    if (kind === "pay") return `${hi} Akaun ahli anda sudah didaftarkan tetapi bayaran belum diterima. Bayaran boleh dibuat secara online di ${portalUrl()} . Terima kasih!`;
    return hi;
  }
  // Malaysian numbers: 012-345 6789 -> 60123456789
  function waNumber(phone) {
    let d = String(phone || "").replace(/\D/g, "");
    if (d.startsWith("0")) d = `6${d}`;
    else if (/^1\d{8,9}$/.test(d)) d = `60${d}`;
    return d.length >= 10 && d.length <= 15 ? d : "";
  }

  function currentRows() {
    const list = LISTS[$("#follow-filter").value];
    if (!list) return [];
    const q = $("#follow-search").value.trim().toLowerCase();
    return people.filter(list.test).filter((p) => !q || [p.member_no, p.full_name, p.phone, p.email]
      .some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => String(a.member_no || "~").localeCompare(String(b.member_no || "~")));
  }

  function renderFollow() {
    const list = LISTS[$("#follow-filter").value];
    const rows = currentRows();
    $("#follow-rows").innerHTML = rows.map((p) => {
      const wa = waNumber(p.phone);
      const link = wa && list?.msg ? `<a class="btn btn--line btn--small" target="_blank" rel="noopener"
          href="https://wa.me/${wa}?text=${encodeURIComponent(message(list.msg, p))}">WhatsApp</a>` : "";
      return `<tr>
        <td class="num">${esc(p.member_no || "—")}</td>
        <td><strong>${esc(p.full_name || "(tiada nama)")}</strong><div class="muted" style="font-size:.8rem">${esc(p.email || "")}</div></td>
        <td>${esc(p.phone || "—")}</td>
        <td class="num">${esc(fmtDate(p.expires_on))}</td>
        <td>${p.account ? '<span class="pill pill--active">Ada akaun</span>' : '<span class="pill pill--new">Belum log masuk</span>'}</td>
        <td>${link}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="muted">Tiada nama dalam senarai ini.</td></tr>`;
    $("#follow-count").textContent = `${num(rows.length)} orang`;
  }
  $("#follow-filter").addEventListener("change", renderFollow);
  $("#follow-search").addEventListener("input", renderFollow);

  // Clicking a headline number or a year column opens that list.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-list]");
    if (!el || !LISTS[el.dataset.list]) return;
    e.preventDefault();
    $("#follow-filter").value = el.dataset.list;
    $("#follow-search").value = "";
    renderFollow();
    $("#follow").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  $("#follow-csv").addEventListener("click", () => {
    const cols = ["member_no", "full_name", "email", "phone", "state", "expires_on"];
    const lines = [[...cols, "portal"].join(",")].concat(currentRows()
      .map((p) => [...cols.map((c) => csvCell(p[c])), p.account ? "Ada akaun" : "Belum log masuk"].join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vcm-${$("#follow-filter").value}-${todayMYT()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $("#follow-copy").addEventListener("click", async () => {
    const phones = [...new Set(currentRows().map((p) => p.phone).filter(Boolean))];
    try {
      await navigator.clipboard.writeText(phones.join("\n"));
      note($("#adm-msg"), `${phones.length} nombor telefon disalin.`, "success");
    } catch {
      note($("#adm-msg"), "Tidak dapat menyalin. Guna butang Muat turun senarai (CSV).", "warn");
    }
  });

  /* ---------- tooltip for chart marks ---------- */
  const tip = $("#dash-tip");
  function showTip(el, x, y) {
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener("focusout", () => { tip.hidden = true; });
  addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });

  init();
})();
