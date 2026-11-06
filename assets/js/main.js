/* =========================================================
   Vespa Club Malaysia — site script
   ---------------------------------------------------------
   To add / update an event, edit the EVENTS list below.
   Events move from "Upcoming" to "Past" automatically
   once their date has passed (Malaysia time).
   ========================================================= */

const VCM = {
  membershipForm: "https://forms.gle/Zg8sRTTM9LAaRp6EA",
  email: "vespaclubmalaysia1946@gmail.com",
  facebook: "https://www.facebook.com/vespaclubmalaysia/",
  instagram: "https://www.instagram.com/vespaclubmalaysia/",
};

const EVENTS = [
  {
    title: "Selangor Scooter Phobia Track Day",
    subtitle: "Vol. 1",
    date: "2026-11-07",
    place: "Horizon Beranang Circuit, Selangor",
    image: "assets/img/event-scooter-phobia-2026.jpg",
    summary: "A full day on track at Horizon Beranang Circuit, with open categories for scooters of every class. Riders must bring full racing gear, and transponders are used for timing.",
  },
  {
    title: "Italian Scooter Day",
    subtitle: "Vol. 2",
    date: "2026-11-29",
    place: "Bukit Jalil Stadium, Kuala Lumpur",
    image: "assets/img/event-italian-scooter-day-2026.jpg",
    summary: "A celebration of Italian scooters, with good people, good vibes, scooter culture and great prizes to be won.",
  },
  {
    title: "Vespa ke Puncak Kinabalu",
    subtitle: "2025",
    date: "2025-01-01",
    dateLabel: "2025",
    place: "Mount Kinabalu, Sabah",
    image: "assets/img/kinabalu-2025-flag.jpg",
    summary: "VCM members flew the Jalur Gemilang at the summit of Mount Kinabalu with a Vespa.",
  },
  {
    title: "Vespa Day",
    subtitle: "2024",
    date: "2024-06-29",
    place: "Bandar Malaysia, Sungai Besi",
    image: "assets/img/vespa-day-2024.jpg",
    summary: "Celebrating Vespa since 1946 with Vespa, music, food and drink, from 2 PM to 10 PM.",
  },
  {
    title: "Vespa Day",
    subtitle: "2020",
    date: "2020-01-01",
    dateLabel: "2020",
    place: "Malaysia",
    image: "assets/img/hero-ride.jpg",
    summary: "Vespa riders filled the streets together to celebrate Vespa Day.",
  },
];

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MYT = "+08:00";
const startOf = (d) => new Date(`${d}T00:00:00${MYT}`);
const endOf = (d) => new Date(`${d}T23:59:59${MYT}`);
const fmtDate = (ev) =>
  ev.dateLabel ||
  startOf(ev.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON = {
  cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  arrow: '<svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M0 6h16M11 1l5 5-5 5"/></svg>',
};

function splitEvents(now = new Date()) {
  const upcoming = EVENTS.filter((e) => endOf(e.date) >= now).sort((a, b) => startOf(a.date) - startOf(b.date));
  const past = EVENTS.filter((e) => endOf(e.date) < now).sort((a, b) => startOf(b.date) - startOf(a.date));
  return { upcoming, past };
}

function cardHTML(ev, isPast) {
  return `
    <article class="card reveal">
      <div class="card__media">
        <img src="${esc(ev.image)}" alt="${esc(ev.title)} ${esc(ev.subtitle || "")} poster" loading="lazy">
        <span class="card__tag ${isPast ? "card__tag--past" : ""}">${isPast ? "Past event" : "Upcoming"}</span>
      </div>
      <div class="card__body">
        <div class="card__date">${esc(fmtDate(ev))}</div>
        <h3>${esc(ev.title)} ${ev.subtitle ? `<span class="muted">${esc(ev.subtitle)}</span>` : ""}</h3>
        <p>${esc(ev.place)}</p>
      </div>
    </article>`;
}

function featuredHTML(ev) {
  return `
    <div class="featured-event">
      <figure class="featured-event__poster reveal" style="margin:0">
        <img src="${esc(ev.image)}" alt="${esc(ev.title)} poster">
      </figure>
      <div class="reveal">
        <span class="eyebrow">Next on the calendar</span>
        <h2 class="h2">${esc(ev.title)} ${ev.subtitle ? esc(ev.subtitle) : ""}</h2>
        <ul class="meta">
          <li>${ICON.cal}${esc(fmtDate(ev))}</li>
          <li>${ICON.pin}${esc(ev.place)}</li>
        </ul>
        <div class="countdown" data-countdown="${esc(ev.date)}" aria-live="polite">
          <div><strong data-u="d">00</strong><span>Days</span></div>
          <div><strong data-u="h">00</strong><span>Hours</span></div>
          <div><strong data-u="m">00</strong><span>Minutes</span></div>
          <div><strong data-u="s">00</strong><span>Seconds</span></div>
        </div>
        <p class="lead" style="margin:0 0 30px">${esc(ev.summary)}</p>
        <a class="btn btn--mint" href="events.html">All events ${ICON.arrow}</a>
      </div>
    </div>`;
}

function renderEvents() {
  const { upcoming, past } = splitEvents();

  const featured = $("[data-featured-event]");
  if (featured) {
    featured.innerHTML = upcoming.length
      ? featuredHTML(upcoming[0])
      : `<div class="reveal"><span class="eyebrow">Events</span><h2 class="h2" style="margin-top:14px">New rides coming soon</h2><p class="lead">Follow us on social media to be the first to know.</p></div>`;
  }

  const up = $("[data-events-upcoming]");
  if (up) {
    up.innerHTML = upcoming.length
      ? upcoming.map((e) => cardHTML(e, false)).join("")
      : `<p class="lead">No upcoming events right now. Check back soon or follow us on Facebook and Instagram.</p>`;
  }
  const pa = $("[data-events-past]");
  if (pa) pa.innerHTML = past.map((e) => cardHTML(e, true)).join("");
}

function startCountdowns() {
  $$("[data-countdown]").forEach((el) => {
    const target = startOf(el.dataset.countdown);
    const tick = () => {
      let diff = Math.max(0, target - new Date());
      const d = Math.floor(diff / 864e5); diff -= d * 864e5;
      const h = Math.floor(diff / 36e5); diff -= h * 36e5;
      const m = Math.floor(diff / 6e4); diff -= m * 6e4;
      const s = Math.floor(diff / 1e3);
      const pad = (n) => String(n).padStart(2, "0");
      $('[data-u="d"]', el).textContent = pad(d);
      $('[data-u="h"]', el).textContent = pad(h);
      $('[data-u="m"]', el).textContent = pad(m);
      $('[data-u="s"]', el).textContent = pad(s);
    };
    tick();
    setInterval(tick, 1000);
  });
}

/* ---------- header / nav ---------- */
function initHeader() {
  const header = $(".site-header");
  const toggle = $(".menu-toggle");
  const overHero = document.body.dataset.header === "over";

  const onScroll = () => {
    if (!overHero) return;
    header.classList.toggle("is-over", window.scrollY < 40);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  toggle?.addEventListener("click", () => {
    const open = document.documentElement.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  $$(".nav a").forEach((a) =>
    a.addEventListener("click", () => {
      document.documentElement.classList.remove("menu-open");
      toggle?.setAttribute("aria-expanded", "false");
    })
  );
}

/* ---------- reveal on scroll ---------- */
function initReveal() {
  const items = $$(".reveal");
  if (!("IntersectionObserver" in window)) return items.forEach((i) => i.classList.add("is-in"));
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }),
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  items.forEach((i) => io.observe(i));
}

/* ---------- shared links ---------- */
function fillLinks() {
  $$("[data-join]").forEach((a) => { a.href = VCM.membershipForm; a.target = "_blank"; a.rel = "noopener"; });
  $$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
}

document.documentElement.classList.remove("no-js");
renderEvents();
startCountdowns();
initHeader();
fillLinks();
initReveal();
