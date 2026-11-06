# Vespa Club Malaysia: laman web baharu

Reka bentuk baharu untuk www.vespaclubmalaysia.com. Kandungannya diambil dari laman Google Sites sedia ada, dan susun aturnya berpandukan gaya vespa.com: bersih, putih, gambar besar dan tipografi tebal. Warnanya ikut lencana VCM (hijau pudina dan biru gelap).

Laman ini ditulis dalam HTML, CSS dan JavaScript biasa. Tiada sistem build. Cukup buka `index.html` dalam pelayar untuk melihatnya.

## Struktur

```
website-club-vespa-malaysia/
├── index.html      Home
├── about.html      About Us
├── team.html       Team (jawatankuasa 2026/2028)
├── events.html     Events & News (+ Google Calendar)
├── shop.html       Shop (Coming soon)
├── contact.html    Contact Us (+ peta)
├── ahli/           Portal ahli (log masuk, profil, kad ahli, renew FPX) + panel AJK
├── supabase/       Pangkalan data dan fungsi bayaran untuk portal ahli
├── docs/           Panduan persediaan sistem keahlian
└── assets/
    ├── css/style.css
    ├── js/main.js  Senarai acara + pautan borang keahlian
    └── img/        Semua gambar
```

## Kemas kini biasa

**Tambah atau ubah acara.** Buka `assets/js/main.js` dan edit senarai `EVENTS`. Setiap acara memerlukan `title`, `date` (format `YYYY-MM-DD`), `place`, `image` dan `summary`. Selepas tarikhnya berlalu (waktu Malaysia), acara itu dipindahkan dari "Upcoming" ke "Past events" secara automatik. Kiraan detik di halaman utama sentiasa menunjuk ke acara seterusnya.

**Tukar pautan borang keahlian.** Edit `membershipForm` di bahagian atas `assets/js/main.js`. Semua butang "Join membership" akan ikut pautan ini.

**Tukar gambar.** Letakkan fail baharu dalam `assets/img/` dengan nama yang sama, atau ubah laluan gambar dalam fail HTML yang berkenaan.

## Portal ahli

Halaman `ahli/` ialah portal untuk ahli log masuk dengan emel, melengkapkan profil, melihat kad ahli digital dan memperbaharui keahlian melalui FPX (ToyyibPay). AJK juga boleh menguruskan senarai ahli di `ahli/admin.html`.

Portal ini perlu disambungkan ke Supabase dan ToyyibPay sebelum boleh digunakan. Ikut panduan langkah demi langkah di [docs/SETUP-KEAHLIAN.md](docs/SETUP-KEAHLIAN.md). Selagi belum disambungkan, halaman `ahli/` cuma memaparkan mesej "coming soon".

## Menerbitkan (percuma)

Pilih salah satu:

1. **GitHub Pages:** pergi ke Settings → Pages, pilih branch `main` dan folder `/ (root)`, kemudian Save.
2. **Netlify / Cloudflare Pages:** sambungkan repo ini, atau seret (drag & drop) folder ini ke dalam dashboard.

Selepas itu, halakan domain `vespaclubmalaysia.com` ke hos baharu melalui tetapan DNS pendaftar domain, dan putuskan sambungan domain itu daripada Google Sites.
