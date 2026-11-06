/* =========================================================
   Member portal connection settings
   ---------------------------------------------------------
   Fill these in after creating the Supabase project
   (Dashboard -> Project Settings -> API). Both values are
   meant to be public: the "anon" key only allows what the
   database rules allow. NEVER put the service_role key here.

   While these are empty, the member portal shows a
   "coming soon" message instead of the login form.
   ========================================================= */
window.VCM_SUPABASE = {
  url: "",      // e.g. "https://abcdefghijkl.supabase.co"
  anonKey: "",  // the long "anon public" key
};
