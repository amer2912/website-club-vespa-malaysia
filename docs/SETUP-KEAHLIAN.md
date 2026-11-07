# Panduan persediaan: Sistem Keahlian VCM

Panduan ini menerangkan cara mengaktifkan **portal ahli** di `vespaclubmalaysia.com/ahli/`. Bila siap, ahli boleh:

- log masuk dengan emel (tiada kata laluan),
- **wajib** melengkapkan profil,
- melihat kad ahli digital,
- memperbaharui keahlian melalui **FPX (ToyyibPay)**.

AJK pula boleh melihat senarai ahli, membuat carian, mengeksport ke Excel dan merekod bayaran tunai atau pindahan bank.

> Sebelum langkah ini selesai, halaman `/ahli/` akan memaparkan mesej "coming soon" berserta pautan borang keahlian. Laman web tidak akan rosak.

**Anggaran masa:** 1 hingga 2 jam untuk persediaan dan ujian sandbox.

---

## Gambaran sistem

```
vespaclubmalaysia.com/ahli/   (GitHub Pages: halaman log masuk, profil, kad, renew)
        │
        ├── Supabase          (log masuk emel + pangkalan data ahli + 2 fungsi bayaran)
        │      ├── create-bill          → cipta bil ToyyibPay untuk ahli yang log masuk
        │      └── toyyibpay-callback   → sahkan bayaran dengan ToyyibPay, kemudian aktifkan keahlian
        │
        └── ToyyibPay         (bayaran FPX)
```

| Fail dalam repo | Fungsi |
|---|---|
| `supabase/migrations/001_membership.sql` | Jadual, peraturan keselamatan dan logik renew |
| `supabase/functions/create-bill/index.ts` | Fungsi cipta bil FPX |
| `supabase/functions/toyyibpay-callback/index.ts` | Fungsi pengesahan bayaran |
| `assets/js/supabase-config.js` | Alamat projek Supabase (diisi pada Langkah 4) |
| `ahli/index.html`, `ahli/admin.html` | Portal ahli dan panel AJK |

**Peraturan keahlian:**
- Keahlian ikut **tahun kalendar** (1 Januari hingga 31 Disember, waktu Malaysia).
- **Ahli baharu RM130, renew RM60.** Boleh ditukar pada Langkah 10.
- Ahli yang masih aktif boleh bayar untuk tahun depan mulai **1 November**.
- Nombor ahli baharu diberi secara automatik selepas bayaran pertama, bermula dari **VCM5020**.

---

## Langkah 1: Cipta projek Supabase

1. Daftar atau log masuk di https://supabase.com guna **emel rasmi kelab**, contohnya `vespaclubmalaysia1946@gmail.com`.
2. Klik **New project**.
   - **Name:** `vcm-membership`
   - **Database password:** jana kata laluan yang kuat dan **simpan di tempat selamat**.
   - **Region:** **Southeast Asia (Singapore)**
   - **Plan:** Free (boleh naik taraf kemudian)
3. Tunggu 1 hingga 2 minit sehingga projek siap.
4. Hidupkan **2FA** pada akaun Supabase: Account → Security.

## Langkah 2: Cipta jadual pangkalan data

1. Di menu kiri, buka **SQL Editor** dan klik **New query**.
2. Buka fail [`supabase/migrations/001_membership.sql`](../supabase/migrations/001_membership.sql) di GitHub, klik ikon **Copy raw file**, kemudian tampal ke dalam SQL Editor.
3. Klik **Run**. Anda sepatutnya nampak mesej *Success. No rows returned*.

Kalau tertekan **Run** dua kali, tiada masalah. Fail ini selamat untuk dijalankan semula.

### 2b. Alat edit untuk AJK
Ulang langkah yang sama untuk fail kedua, [`supabase/migrations/002_admin_edit.sql`](../supabase/migrations/002_admin_edit.sql). Fail ini menambah tiga ciri pada panel AJK:
- butang **Edit** untuk mengubah nombor ahli, profil dan tarikh "Valid until";
- kaedah bayaran **Old Google Form**, untuk ahli yang sudah bayar melalui borang lama;
- senarai **Pre-registered**, untuk menambah ahli yang belum pernah log masuk.

### 2c. Yuran ahli baharu dan renew
Ulang langkah yang sama untuk fail ketiga, [`supabase/migrations/003_new_member_fee.sql`](../supabase/migrations/003_new_member_fee.sql). Fail ini menetapkan:
- **Ahli baharu: RM130.** Untuk orang yang tiada nombor ahli dan belum pernah bayar.
- **Renew: RM60.** Untuk ahli yang ada nombor ahli atau pernah bayar.
- **Nombor ahli automatik bermula dari VCM5020.**

Portal memaparkan **kedua-dua** pilihan, tetapi hanya pilihan yang layak boleh ditekan. Jenis yuran ditentukan oleh pangkalan data, jadi ahli tidak boleh memilih sendiri atau menukar dirinya kepada "ahli lama".

Jalankan fail mengikut susunan `001`, `002`, kemudian `003`. Semuanya selamat untuk dijalankan semula, dan nombor ahli tidak akan berundur.

## Langkah 3: Tetapan log masuk emel

### 3a. Alamat laman
Buka **Authentication → URL Configuration**:
- **Site URL:** `https://vespaclubmalaysia.com/ahli/`
- **Redirect URLs:** tambah `https://vespaclubmalaysia.com/ahli/` dan `https://www.vespaclubmalaysia.com/ahli/`

### 3b. Templat emel (supaya ahli dapat kod 6 digit): buat SELEPAS 3c
Supabase hanya membenarkan templat diubah **selepas Custom SMTP (3c) disediakan**. Sebelum itu, emel lalai cuma mengandungi pautan **Sign in**. Pautan itu tetap boleh digunakan untuk log masuk, jadi anda boleh terus ke Langkah 4 dan menguji sistem dengan pautan dahulu.

Selepas 3c siap, buka **Authentication → Emails → Magic Link**, kemudian tukar kandungannya kepada:

- **Subject:** `Kod log masuk Vespa Club Malaysia`
- **Body:**
```html
<h2>Vespa Club Malaysia</h2>
<p>Kod log masuk anda:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Atau tekan pautan ini: <a href="{{ .ConfirmationURL }}">Log masuk ke portal ahli</a></p>
<p>Kod ini sah untuk satu jam. Abaikan emel ini jika anda tidak meminta untuk log masuk.</p>
```
Gunakan templat yang sama untuk **Confirm signup**. Emel ini dihantar kepada ahli yang log masuk buat kali pertama.

### 3c. Penghantar emel (SMTP), WAJIB sebelum dibuka kepada ahli
Penghantar emel bawaan Supabase hanya sesuai untuk ujian. Had penghantarannya sangat rendah (beberapa emel sejam), dan ia mungkin hanya menghantar kepada ahli pasukan projek. Untuk ahli sebenar, sambungkan perkhidmatan emel percuma seperti **Resend** atau **Brevo**:

1. Daftar akaun di Resend (https://resend.com) atau Brevo (https://brevo.com).
2. Sahkan domain `vespaclubmalaysia.com`. Mereka akan beri beberapa rekod DNS untuk ditambah di **Squarespace → DNS**, sama seperti cara rekod GitHub Pages ditambah dulu.
3. Ambil maklumat SMTP (host, port, username, password) daripada akaun tersebut.
4. Di Supabase, buka **Authentication → Emails → SMTP Settings**, hidupkan **Custom SMTP**, dan isi:
   - **Sender email:** `noreply@vespaclubmalaysia.com`
   - **Sender name:** `Vespa Club Malaysia`
   - Host, port, username dan password daripada Resend atau Brevo.
5. Di **Authentication → Rate Limits**, semak had emel sejam dan naikkan jika perlu.

## Langkah 4: Sambungkan laman web ke Supabase

1. Di Supabase, salin dua nilai ini:
   - **Project URL**, contohnya `https://abcdefghijkl.supabase.co`. Ia boleh didapati di **Project Settings → Data API**, atau dengan menekan butang **Connect** di bahagian atas.
   - **Publishable key** (bermula dengan `sb_publishable_...`), di **Project Settings → API Keys**. Gunakan kunci baharu ini kerana kunci legacy (`anon`) akan ditamatkan pada awal 2027.
2. Di GitHub, buka [`assets/js/supabase-config.js`](../assets/js/supabase-config.js) dan klik ikon pensel ✏️.
3. Isi kedua-dua nilai:
```js
window.VCM_SUPABASE = {
  url: "https://abcdefghijkl.supabase.co",
  anonKey: "sb_publishable_...",
};
```
4. Klik **Commit changes**. Laman akan dikemas kini dalam 1 hingga 2 minit.

⚠️ **Jangan sekali-kali** letak **secret key** (`sb_secret_...`) atau kunci **service_role** dalam fail ini, atau di mana-mana tempat dalam repo. Publishable key memang dibenarkan untuk umum. Secret key pula boleh membuka semua data.

## Langkah 5: Jadikan AJK sebagai admin

Di **SQL Editor**, jalankan arahan ini (tukar kepada emel sebenar AJK):
```sql
insert into public.admins (email) values
  ('setiausaha@example.com'),
  ('bendahari@example.com');
```
AJK tersebut kemudian log masuk di `/ahli/` dengan emel yang sama. Butang **AJK admin** akan muncul di papan pemuka mereka. Hadkan akses admin kepada 2 hingga 3 orang sahaja.

## Langkah 6: Import ahli sedia ada (pilihan)

Langkah ini membolehkan ahli lama terus nampak nombor ahli dan tarikh luput mereka pada kali pertama log masuk.

1. Sediakan fail CSV dengan lajur berikut (baris pertama ialah tajuk):
```
email,member_no,full_name,phone,expires_on,joined_on
ali@gmail.com,VCM0012,Ali Bin Abu,0123456789,2026-12-31,2019-08-02
```
   - `expires_on`: `2026-12-31` untuk ahli yang aktif bagi 2026. Biarkan kosong untuk ahli yang belum bayar.
   - Tarikh mesti dalam format `YYYY-MM-DD`.
2. Di Supabase, buka **Table Editor → member_import → Insert → Import data from CSV**.
3. Fail `003` sudah menetapkan nombor ahli baharu bermula dari **VCM5020**. Sistem juga melangkau nombor yang sudah diambil secara automatik.

## Panel AJK: kemas kini ahli secara manual

Buka portal, tekan **AJK admin**, dan anda boleh buat perkara berikut.

| Mahu buat | Cara |
|---|---|
| Beri atau tukar nombor ahli | Tekan **Edit** pada baris ahli, isi **Member no.**, kemudian **Save changes**. Sistem menolak nombor yang sudah digunakan orang lain. |
| Tanda ahli **sudah bayar 2026** (melalui Google Form lama) | Tekan **Payment**, pilih tahun `2026`, kaedah **Old Google Form**, dan isi jumlah (RM0 jika tidak tahu). Status akan menjadi Active hingga 31 Dis 2026, dan bayaran itu tercatat dalam sejarah. |
| Tanda ahli **belum bayar** (betulkan kesilapan) | Tekan **Edit**, **kosongkan** tarikh **Valid until**, kemudian **Save changes**. |
| Tambah ahli yang **belum log masuk** | Di bahagian **Pre-registered**, tekan **Add member** dan isi emel, nombor ahli serta tarikh sah. Bila ahli itu log masuk kali pertama dengan emel tersebut, semua maklumat ini terus dipindahkan ke akaunnya. |
| Rekod bayaran tunai atau pindahan bank | Tekan **Payment** dan pilih **Cash** atau **Bank transfer**. |

## Langkah 7: Akaun ToyyibPay (mula dengan sandbox)

1. Daftar akaun **sandbox** di https://dev.toyyibpay.com.
2. Cipta **Category**, contohnya `Yuran Keahlian VCM`, dan catat **Category Code**.
3. Dapatkan **User Secret Key** daripada menu akaun atau profil.

Sandbox ialah persekitaran ujian dan tiada wang sebenar terlibat. Selepas semua ujian berjaya, ulang langkah ini di https://toyyibpay.com (akaun sebenar). Akaun sebenar perlu didaftarkan atas nama kelab, dengan dokumen ROS dan akaun bank kelab.

## Langkah 8: Pasang fungsi bayaran (Edge Functions)

### 8a. Rahsia (secrets)
Di Supabase, buka **Edge Functions → Secrets** dan tambah:

| Name | Value |
|---|---|
| `TOYYIBPAY_SECRET_KEY` | User Secret Key ToyyibPay |
| `TOYYIBPAY_CATEGORY_CODE` | Category Code |
| `TOYYIBPAY_BASE_URL` | `https://dev.toyyibpay.com` (sandbox). Tukar ke `https://toyyibpay.com` bila live. |
| `SITE_URL` | `https://vespaclubmalaysia.com` |

### 8b. Fungsi `create-bill`
1. Buka **Edge Functions → Deploy a new function → Via Editor**.
2. Namakan fungsi `create-bill`. Nama mesti tepat.
3. Padam kod contoh, kemudian tampal kandungan [`supabase/functions/create-bill/index.ts`](../supabase/functions/create-bill/index.ts).
4. Klik **Deploy**.

### 8c. Fungsi `toyyibpay-callback`
1. Ulang langkah 8b dengan nama `toyyibpay-callback` dan fail [`supabase/functions/toyyibpay-callback/index.ts`](../supabase/functions/toyyibpay-callback/index.ts).

### 8d. Matikan "Verify JWT" untuk KEDUA-DUA fungsi
Untuk setiap fungsi (`create-bill` dan `toyyibpay-callback`), buka **Details** atau tetapan fungsi, kemudian **matikan "Enforce JWT Verification"** (Verify JWT) dan simpan.

- `toyyibpay-callback`: ToyyibPay tidak boleh menghantar token log masuk Supabase. Fungsi ini tetap selamat kerana ia sentiasa menyemak semula status bayaran dengan ToyyibPay sebelum mengaktifkan keahlian.
- `create-bill`: semakan JWT automatik Supabase tidak serasi dengan kunci API baharu (`sb_publishable_` / `sb_secret_`). Fungsi ini tetap selamat kerana ia **menyemak sendiri** token log masuk ahli dengan Supabase Auth, dan menolak permintaan yang tidak log masuk.

Fungsi-fungsi ini mengambil kunci projek daripada Supabase secara automatik, jadi anda tidak perlu menambah kunci secara manual. Jika suatu hari log fungsi menunjukkan *"Server keys are not configured"*, tambah secret `VCM_SECRET_KEY` dengan nilai **secret key** (`sb_secret_...`) daripada **Project Settings → API Keys**.

## Langkah 9: Uji dengan sandbox

1. Buka `https://vespaclubmalaysia.com/ahli/` dan log masuk dengan emel anda.
2. Profil wajib akan keluar. Isi dan simpan.
3. Di papan pemuka, klik **Pay with FPX**. Anda akan dibawa ke halaman ToyyibPay sandbox.
4. Bayar menggunakan bank ujian yang disediakan dalam sandbox.
5. Anda akan kembali ke portal. Semak bahawa:
   - mesej *Payment received* keluar,
   - kad menunjukkan **Active** dan ada nombor ahli,
   - *Payment history* menyenaraikan bayaran tersebut.
6. Log masuk sebagai AJK admin. Pastikan ahli tadi ada dalam senarai, kemudian cuba **Record payment** dan **Export to Excel**.

Kalau ada masalah, buka **Edge Functions → (nama fungsi) → Logs** untuk melihat ralat. Butiran API ToyyibPay (nama medan, format jawapan) disemak semasa pembinaan berdasarkan dokumentasi awam mereka. Ujian sandbox inilah yang mengesahkan semuanya berfungsi dengan akaun sebenar.

## Langkah 10: Go live

1. Daftar akaun ToyyibPay **sebenar** atas nama kelab, cipta Category, dan ambil Secret Key yang baharu.
2. Kemas kini secrets: `TOYYIBPAY_BASE_URL` = `https://toyyibpay.com`, beserta `TOYYIBPAY_SECRET_KEY` dan `TOYYIBPAY_CATEGORY_CODE` yang baharu.
3. Untuk tukar **yuran** atau **bulan renew dibuka**, buka **Table Editor → settings**:
   - `new_member_fee_cents`: yuran ahli baharu, dalam sen. `13000` = RM130.00.
   - `fee_cents`: yuran renew, dalam sen. `6000` = RM60.00.
   - `renewal_opens_month`: `11` = November.
4. Umumkan portal kepada ahli. 🎉

## Langkah 11: Pastikan projek percuma tidak di-pause

Pada pelan percuma, Supabase akan pause projek yang tiada aktiviti selama 7 hari. Gunakan **cron-job.org** (percuma) untuk "mengetuk" projek setiap 3 hari:

1. Daftar di https://cron-job.org dan klik **Create cronjob**.
2. Isi:
   - **URL:** `https://<PROJECT-REF>.supabase.co/rest/v1/rpc/ping`
   - **Schedule:** setiap 3 hari
   - **Advanced → Request method:** `POST`
   - **Headers:** `apikey: <publishable key>` dan `Content-Type: application/json`
   - **Request body:** `{}`
3. Simpan, dan hidupkan notifikasi emel jika gagal.

Fungsi `ping` cuma memulangkan "ok", dan tidak membaca atau mengubah data ahli.

## Langkah 12: Backup dan keselamatan

- **Setiap bulan**, log masuk sebagai admin dan klik **Export to Excel (CSV)**. Simpan fail itu dalam **Google Drive kelab**, bukan di GitHub kerana repo ini public. Pelan percuma tiada backup automatik.
- Hidupkan 2FA pada akaun Supabase, GitHub, ToyyibPay dan Gmail kelab.
- Jangan kongsi senarai ahli dalam group WhatsApp.
- Bila ahli semakin ramai, pertimbangkan pelan **Supabase Pro** (lebih kurang USD25 sebulan). Pelan ini ada backup harian dan projek tidak akan di-pause.

---

## Soalan lazim

**Ahli tidak menerima emel kod.**
Minta ahli semak folder Spam atau Promotions. Pastikan Custom SMTP (Langkah 3c) sudah disediakan. Di Supabase, semak **Authentication → Logs** untuk sebarang ralat.

**Ahli sudah bayar tetapi status masih belum aktif.**
Minta ahli muat semula halaman portal. Kalau masih belum aktif, semak **Edge Functions → toyyibpay-callback → Logs**. Pastikan Verify JWT untuk fungsi tersebut sudah dimatikan (Langkah 8c). AJK juga boleh merekod bayaran secara manual di panel admin.

**Ahli tukar emel.**
Buka **Authentication → Users**, cari pengguna tersebut, dan kemas kini emelnya. Kemudian kemas kini juga lajur `email` dalam jadual `members`.

**Bagaimana nak buang akses admin?**
Jalankan arahan ini di SQL Editor:
```sql
delete from public.admins where email = 'emel@example.com';
```
