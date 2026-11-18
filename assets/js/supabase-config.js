/* =========================================================
   Member portal connection settings
   ---------------------------------------------------------
   Fill these in after creating the Supabase project
   (Project Settings -> Data API / API Keys). Both values are
   meant to be public: the publishable key (sb_publishable_...)
   only allows what the database rules allow.
   NEVER put a secret key (sb_secret_...) or service_role key here.

   If these are emptied, the member portal shows a
   "coming soon" message instead of the login form.
   ========================================================= */
window.VCM_SUPABASE = {
  url: "https://iyjlrjrqnmkgfcadwydg.supabase.co",
  anonKey: "sb_publishable_qxkuJfHMD9DHBVG1QwYLqw_p7YoO4dV", // publishable key (safe to be public)
};

/* =========================================================
   Maintenance switch for online payments
   ---------------------------------------------------------
   paymentsPaused: true  -> event pages (Vespa Day, ISD) and the
   member portal stop taking new online payments and show the
   message below. Paid tickets, QR codes, the event counter and
   member logins keep working.
   To start taking payments again, set paymentsPaused to false.
   ========================================================= */
window.VCM_MAINTENANCE = {
  paymentsPaused: true,
  // true hides the secretary's WhatsApp number shown on tickets (organiser contact).
  hideContactNumber: true,
  message: "Sistem pembayaran sedang diselenggara buat sementara waktu. Sila kembali tidak lama lagi. · Our payment system is under maintenance for a short while. Please check back soon.",
};
