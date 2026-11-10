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
  // Club constitution: arrears of more than three years' fees end the membership.
  const MAX_ARREARS_YEARS = 3;
  const owedYears = (p) => { const y = endYear(p); return y ? Math.max(0, Y - y) : null; };
  function standing(p) {
    if (!p.expires_on) return p.archive ? "unknown" : "never";
    const o = owedYears(p);
    if (o === 0) return "active";
    return o <= MAX_ARREARS_YEARS ? `owe${o}` : "ceased";
  }
  const STANDING = {
    active: "Aktif",
    owe1: "Tertunggak 1 tahun",
    owe2: "Tertunggak 2 tahun",
    owe3: "Tertunggak 3 tahun",
    ceased: `Terhenti: tunggakan lebih ${MAX_ARREARS_YEARS} tahun`,
    unknown: "Tiada rekod bayaran (rekod lama)",
    never: "Akaun baharu, belum bayar",
  };
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
  let hasArchive = false;
  let follow = new Map();

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

  // 'editor', 'viewer' or null. Falls back to is_admin() until 007 is run.
  async function adminRole() {
    const r = await sb.rpc("my_admin_role");
    if (!r.error) return r.data || null;
    const a = await sb.rpc("is_admin");
    return a.data === true ? "editor" : null;
  }
  let viewer = false;

  async function init() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { deny("Sila log masuk", "Log masuk di portal ahli dengan emel AJK anda dahulu."); return; }
    const role = await adminRole();
    if (!role) { deny("AJK sahaja", "Akaun anda tiada akses admin AJK. Minta setiausaha kelab tambah emel anda dalam senarai admin."); return; }
    view("adm-main");
    viewer = role === "viewer";
    document.body.classList.toggle("is-viewer", viewer);
    if (await loadData()) renderAll();
    if (viewer) note($("#adm-msg"), "Akses lihat sahaja: anda boleh lihat dan muat turun senarai, tetapi perubahan dibuat oleh AJK editor.", "info");
  }

  // Tables added by 006; until it is run the dashboard works without old records.
  const optional = (promise) => promise.catch(() => null);

  async function loadData() {
    try {
      const [members, imports, pays, settings, archive, followups] = await Promise.all([
        fetchAll(() => sb.from("members").select("*").order("member_no", { ascending: true, nullsFirst: false })),
        fetchAll(() => sb.from("member_import").select("email, member_no, full_name, phone, expires_on").order("member_no", { ascending: true, nullsFirst: false })),
        fetchAll(() => sb.from("payments").select("member_id, coverage_year, amount_cents, kind, method, paid_at").eq("status", "paid").order("paid_at", { ascending: true })),
        sb.from("settings").select("*").maybeSingle(),
        optional(fetchAll(() => sb.from("member_archive").select("*").order("member_no", { ascending: true }))),
        optional(fetchAll(() => sb.from("member_followup").select("*"))),
      ]);
      hasArchive = archive !== null;
      follow = new Map((followups || []).map((f) => [f.member_no, f]));
      if (settings?.data?.fee_cents) fee = settings.data.fee_cents;
      const withAccount = new Set(members.map((m) => String(m.email || "").toLowerCase()));
      people = members.map((m) => ({ ...m, account: true }))
        .concat(imports.filter((r) => !withAccount.has(String(r.email || "").toLowerCase())).map((r) => ({ ...r, account: false })));
      const used = new Set(people.map((p) => p.member_no).filter(Boolean));
      people = people.concat((archive || []).filter((a) => !used.has(a.member_no)).map((a) => ({
        ...a, account: false, archive: true, expires_on: a.last_paid_year ? `${a.last_paid_year}-12-31` : null,
      })));
      payments = pays;
      return true;
    } catch (err) {
      note($("#adm-msg"), `Data tidak dapat dimuatkan: ${err.message || err}`, "error");
      return false;
    }
  }

  function renderAll() {
    $("#dash-asof").textContent = `Data terkini pada ${fmtDate(todayMYT())}. Termasuk ahli yang belum log masuk portal${hasArchive ? " dan rekod lama" : ""}.`;
    $("#arch-add").hidden = !hasArchive;
    renderKpis();
    renderYears();
    renderMonths();
    renderStanding();
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
    const archived = people.filter((p) => p.archive).length;
    const tiles = [
      [num(people.length), "Jumlah dalam rekod", archived ? `Termasuk ${num(archived)} rekod lama` : "Akaun dan pra-daftar", "all"],
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
    $("#years-note").textContent = none ? `${num(none)} orang tanpa rekod bayaran tidak ditunjukkan.` : "";
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

  /* ---------- chart: standing under the constitution ---------- */
  function renderStanding() {
    const counts = {};
    people.forEach((p) => { const s = standing(p); counts[s] = (counts[s] || 0) + 1; });
    const keys = Object.keys(STANDING).filter((k) => counts[k]);
    const max = Math.max(1, ...keys.map((k) => counts[k]));
    const owing = people.filter((p) => /^owe|ceased/.test(standing(p)));
    const noticed = owing.filter((p) => follow.get(p.member_no)?.debt_notice_sent_on).length;
    $("#chart-standing").innerHTML = `<div class="hbars">${keys.map((k) => `
        <button type="button" class="hbar" data-list="st-${k}" data-tip="${esc(`<strong>${esc(STANDING[k])}</strong><br>${num(counts[k])} orang<br>Tekan untuk lihat nama`)}">
          <span class="hbar-label">${esc(STANDING[k])}</span>
          <span class="hbar-track"><span class="hbar-fill" style="width:${(counts[k] / max) * 100}%;background:var(${k === "unknown" || k === "never" ? "--c-past" : "--c-renew"})"></span></span>
          <span class="hbar-val">${num(counts[k])}</span>
        </button>`).join("")}</div>`;
    $("#standing-note").textContent = owing.length
      ? `Notis hutang sudah direkodkan untuk ${num(noticed)} daripada ${num(owing.length)} ahli yang tertunggak atau terhenti.` : "";
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
  let LISTS = {};
  function buildFilters() {
    const keep = $("#follow-filter").value;
    LISTS = {};
    const ended = [...new Set(people.map(endYear).filter((y) => y && y < Y))].sort((a, b) => b - a);
    const add = (key, label, test, msg) => { LISTS[key] = { label, test, msg }; };
    ended.forEach((y, i) => add(`lapsed-${y}`,
      i === 0 && y === Y - 1 ? `Belum renew ${Y} (terakhir bayar ${y})` : `Terakhir bayar ${y}`,
      (p) => endYear(p) === y, "renew"));
    ["owe1", "owe2", "owe3", "ceased", "unknown"].forEach((k) => add(`st-${k}`, STANDING[k], (p) => standing(p) === k,
      k === "ceased" || k === "unknown" ? "reconnect" : "notice"));
    add("st-active", STANDING.active, (p) => standing(p) === "active", null);
    add("st-never", STANDING.never, (p) => standing(p) === "never", "pay");
    add("notice", "Notis hutang sudah dihantar", (p) => !!follow.get(p.member_no)?.debt_notice_sent_on, null);
    add("claims", "Akaun baharu yang menuntut nombor lama (perlu disahkan)", (p) => p.account && !p.member_no && !!p.claimed_member_no, null);
    if (hasArchive) add("archive", "Rekod lama (belum boleh log masuk)", (p) => p.archive, "reconnect");
    add("all", "Semua ahli", () => true, null);
    add("prereg", "Belum log masuk portal (didaftarkan oleh AJK)", (p) => !p.account && !p.archive, "login");
    add("incomplete", `Ahli aktif ${Y}, profil belum lengkap`, (p) => p.account && paidFor(p, Y) && !p.profile_completed_at, "profile");
    add("nopaid", "Ada akaun tetapi belum pernah bayar", (p) => p.account && !p.expires_on, "pay");
    [...new Set(people.map(endYear).filter((y) => y && y >= Y))].sort().forEach((y) =>
      add(`active-${y}`, `Aktif, tamat ${y}`, (p) => endYear(p) === y, null));
    $("#follow-filter").innerHTML = Object.entries(LISTS)
      .map(([k, l]) => `<option value="${k}">${esc(l.label)} (${num(people.filter(l.test).length)})</option>`).join("");
    if (LISTS[keep]) $("#follow-filter").value = keep;
  }

  const portalUrl = () => `${location.origin}/ahli/`;
  function message(kind, p) {
    const no = p.member_no ? ` (${p.member_no})` : "";
    const hi = "Salam, ini AJK Vespa Club Malaysia.";
    if (kind === "renew") return `${hi} Keahlian anda${no} telah tamat pada ${fmtDate(p.expires_on)}. Pembaharuan ${rm(fee)} kini boleh dibuat secara online di ${portalUrl()} . Terima kasih!`;
    if (kind === "login") return `${hi} Keahlian kini diurus melalui portal ahli: ${portalUrl()} . Log masuk dengan emel ${p.email} untuk lihat kad ahli${no} anda. Terima kasih!`;
    if (kind === "profile") return `${hi} Sila lengkapkan profil ahli anda${no} di ${portalUrl()} . Terima kasih!`;
    if (kind === "notice") {
      const from = endYear(p) + 1;
      return `${hi} Rekod kami menunjukkan yuran keahlian anda${no} bagi tahun ${from === Y ? Y : `${from} hingga ${Y}`} belum dijelaskan. Mengikut perlembagaan kelab, ahli yang tertunggak yuran melebihi ${MAX_ARREARS_YEARS} tahun terhenti daripada menjadi ahli. Bayaran boleh dibuat secara online di ${portalUrl()} . Terima kasih!`;
    }
    if (kind === "reconnect") return `${hi} Kami sedang mengemas kini rekod ahli. Rekod kami menunjukkan anda pernah menjadi ahli${no}. Jika anda ingin aktif semula, sila balas mesej ini dengan emel anda supaya AJK boleh daftarkan anda di portal ahli. Terima kasih!`;
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

  // Typing "518", "vcm518" or "VCM-0518" all find member VCM-0518.
  const noDigits = (v) => { const m = String(v || "").match(/^\s*(?:vcm)?[\s-]*0*(\d{1,5})\s*$/i); return m ? m[1] : null; };
  function matches(p, q) {
    const n = noDigits(q);
    // Up to 4 digits, or starting with "vcm": a member number, matched exactly.
    if (n && (/^\s*vcm/i.test(q) || n.length <= 4)) return noDigits(p.member_no) === n;
    return [p.member_no, p.full_name, p.phone, p.email].some((v) => String(v || "").toLowerCase().includes(q));
  }
  // A search looks through every member, whichever list is chosen.
  function currentRows() {
    const q = $("#follow-search").value.trim().toLowerCase();
    const list = LISTS[$("#follow-filter").value];
    const pool = q ? people : list ? people.filter(list.test) : [];
    return pool.filter((p) => !q || matches(p, q))
      .sort((a, b) => String(a.member_no || "~").localeCompare(String(b.member_no || "~")));
  }
  function messageKind(p) {
    const st = standing(p);
    if (p.archive || st === "ceased" || st === "unknown") return "reconnect";
    if (/^owe/.test(st)) return "notice";
    if (!p.account) return "login";
    if (!p.expires_on) return "pay";
    if (!p.profile_completed_at) return "profile";
    return null;
  }

  function renderFollow() {
    const list = LISTS[$("#follow-filter").value];
    const searching = !!$("#follow-search").value.trim();
    const rows = currentRows();
    $("#follow-rows").innerHTML = rows.map((p) => {
      const wa = waNumber(p.phone);
      const kind = searching ? messageKind(p) : list?.msg;
      const link = wa && kind ? `<a class="btn btn--line btn--small" target="_blank" rel="noopener" data-wa="${kind}" data-no="${esc(p.member_no || "")}"
          href="https://wa.me/${wa}?text=${encodeURIComponent(message(kind, p))}">WhatsApp</a>` : "";
      const f = follow.get(p.member_no);
      const rec = p.archive ? '<span class="pill pill--expired">Rekod lama</span>'
        : p.account ? '<span class="pill pill--active">Ada akaun</span>' : '<span class="pill pill--new">Belum log masuk</span>';
      const claims = p.claimed_member_no && !p.member_no ? `<div class="claimed">menuntut ${esc(p.claimed_member_no)}</div>` : "";
      return `<tr>
        <td class="num">${esc(p.member_no || "—")}${claims}</td>
        <td><strong>${esc(p.full_name || "(tiada nama)")}</strong><div class="muted" style="font-size:.8rem">${esc(p.email || "")}</div></td>
        <td>${esc(p.phone || "—")}</td>
        <td class="num">${esc(p.expires_on ? fmtDate(p.expires_on) : "Tiada rekod")}<div class="muted" style="font-size:.78rem">${esc(STANDING[standing(p)])}</div></td>
        <td>${rec}${p.note ? `<div class="muted" style="font-size:.78rem;max-width:260px">${esc(p.note)}</div>` : ""}</td>
        <td class="num">${f?.debt_notice_sent_on ? esc(fmtDate(f.debt_notice_sent_on)) : "—"}${f?.ajk_note ? `<div class="muted" style="font-size:.78rem;max-width:220px">${esc(f.ajk_note)}</div>` : ""}</td>
        <td><div class="form-actions" style="flex-wrap:nowrap">${link}<button class="btn btn--line btn--small" type="button" data-rec="${esc(p.member_no || "")}" data-email="${esc(p.email || "")}">Kemaskini</button></div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="7" class="muted">Tiada nama dalam senarai ini.</td></tr>`;
    $("#follow-count").textContent = searching ? `${num(rows.length)} dijumpai (carian dalam semua ahli)` : `${num(rows.length)} orang`;
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
    const cols = ["member_no", "full_name", "email", "phone", "state", "expires_on", "note"];
    const lines = [[...cols, "status", "rekod", "notis_hutang", "catatan_ajk"].join(",")].concat(currentRows()
      .map((p) => [...cols.map((c) => csvCell(p[c])), csvCell(STANDING[standing(p)]),
        p.archive ? "Rekod lama" : p.account ? "Ada akaun" : "Belum log masuk",
        csvCell(follow.get(p.member_no)?.debt_notice_sent_on), csvCell(follow.get(p.member_no)?.ajk_note)].join(",")));
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

  /* ---------- update a record: old-record details, notice of unpaid fees ---------- */
  const dlg = $("#rec-dialog");
  const orNull = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : t; };
  let editing = null;
  function openRecord(p) {
    editing = p;
    const isArchive = !p || p.archive;
    $("#rec-title").textContent = p ? `Kemaskini ${p.member_no || p.email || ""}` : "Tambah rekod lama";
    $("#rec-archive").hidden = !isArchive;
    $("#rec-portal-hint").hidden = isArchive;
    $("#rec-member_no").value = p?.member_no || "";
    $("#rec-member_no").readOnly = !!p;
    $("#rec-full_name").value = p?.full_name || "";
    $("#rec-phone").value = p?.phone || "";
    $("#rec-email").value = p?.email || "";
    $("#rec-last_paid_year").value = p?.last_paid_year || "";
    $("#rec-note").value = p?.archive ? p.note || "" : "";
    const f = p?.member_no ? follow.get(p.member_no) : null;
    $("#rec-follow").hidden = !!p && !p.member_no;
    $("#rec-notice").value = f?.debt_notice_sent_on || "";
    $("#rec-ajk_note").value = f?.ajk_note || "";
    $("#rec-move").hidden = !p?.archive;
    $("#rec-delete").hidden = !p?.archive;
    note($("#rec-msg"), "");
    dlg.showModal();
  }
  $("#arch-add").addEventListener("click", () => openRecord(null));
  $("#rec-cancel").addEventListener("click", () => dlg.close());
  $("#rec-today").addEventListener("click", () => { $("#rec-notice").value = todayMYT(); });
  $("#follow-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rec]");
    if (!b) return;
    const p = people.find((x) => (b.dataset.rec && x.member_no === b.dataset.rec) || (!b.dataset.rec && x.email && x.email === b.dataset.email));
    if (p) openRecord(p);
  });

  async function refresh(msg) {
    dlg.close();
    if (await loadData()) renderAll();
    note($("#adm-msg"), msg, "success");
  }
  async function saveRecord() {
    const isArchive = !editing || editing.archive;
    let no = editing?.member_no || orNull($("#rec-member_no").value);
    if (isArchive) {
      const year = orNull($("#rec-last_paid_year").value);
      const { data, error } = await sb.rpc("admin_upsert_archive", {
        p_member_no: no, p_full_name: orNull($("#rec-full_name").value), p_phone: orNull($("#rec-phone").value),
        p_email: orNull($("#rec-email").value), p_last_paid_year: year ? Number(year) : null, p_note: orNull($("#rec-note").value),
      });
      if (error) throw error;
      no = data?.member_no || no;
    }
    const f = follow.get(no);
    const notice = orNull($("#rec-notice").value);
    const ajkNote = orNull($("#rec-ajk_note").value);
    if (no && (notice || ajkNote || f)) {
      const { error } = await sb.rpc("admin_set_followup", { p_member_no: no, p_notice_sent_on: notice, p_note: ajkNote });
      if (error) throw error;
    }
    return no;
  }
  $("#rec-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || $("#rec-form button[type=submit]");
    btn.disabled = true;
    try {
      const no = await saveRecord();
      await refresh(`Rekod ${no || ""} disimpan.`);
    } catch (err) {
      note($("#rec-msg"), err.message || String(err), "error");
    } finally {
      btn.disabled = false;
    }
  });
  $("#rec-move").addEventListener("click", async () => {
    const email = orNull($("#rec-email").value);
    if (!email) { note($("#rec-msg"), "Isi emel ahli dahulu. Emel ini yang akan digunakan untuk log masuk.", "error"); return; }
    if (!window.confirm(`Pindahkan ${editing.member_no} ke senarai pra-daftar? Bila ahli log masuk dengan ${email}, nombor ${editing.member_no} terus menjadi miliknya.`)) return;
    try {
      await saveRecord();
      const { error } = await sb.rpc("admin_archive_to_import", { p_member_no: editing.member_no, p_email: email });
      if (error) throw error;
      await refresh(`${editing.member_no} kini dalam senarai pra-daftar. Ahli boleh log masuk dengan ${email}.`);
    } catch (err) {
      note($("#rec-msg"), err.message || String(err), "error");
    }
  });
  $("#rec-delete").addEventListener("click", async () => {
    if (!window.confirm(`Padam rekod lama ${editing.member_no}? Tindakan ini tidak boleh dibatalkan.`)) return;
    const { error } = await sb.rpc("admin_delete_archive", { p_member_no: editing.member_no });
    if (error) { note($("#rec-msg"), error.message, "error"); return; }
    await refresh(`Rekod lama ${editing.member_no} dipadam.`);
  });

  // After a notice goes out on WhatsApp, offer to record the date as proof of notice.
  $("#follow-rows").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-wa='notice']");
    if (!a || !a.dataset.no || viewer) return;
    setTimeout(async () => {
      if (!window.confirm(`Rekodkan notis hutang untuk ${a.dataset.no} sebagai dihantar hari ini (${fmtDate(todayMYT())})?`)) return;
      const prev = follow.get(a.dataset.no);
      const { error } = await sb.rpc("admin_set_followup", {
        p_member_no: a.dataset.no, p_notice_sent_on: todayMYT(), p_note: prev?.ajk_note || "Notis dihantar melalui WhatsApp",
      });
      if (error) { note($("#adm-msg"), error.message, "error"); return; }
      if (await loadData()) renderAll();
      note($("#adm-msg"), `Notis hutang untuk ${a.dataset.no} direkodkan.`, "success");
    }, 400);
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
