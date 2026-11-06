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
  url: "https://klqlpnoghudrdtvnseag.supabase.co",
  anonKey: "sb_publishable_YovHOrqevxs6bx0DV38wvw_oMG2_q50", // publishable key (safe to be public)
};
