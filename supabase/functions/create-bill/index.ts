// Supabase Edge Function: create-bill
// Starts an FPX renewal payment with ToyyibPay for the logged-in member.
//
// Called by the member portal with the member's login token. The amount and
// membership year are worked out in the database (start_renewal), never taken
// from the browser.
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   TOYYIBPAY_SECRET_KEY     your ToyyibPay user secret key
//   TOYYIBPAY_CATEGORY_CODE  category code created in ToyyibPay
//   TOYYIBPAY_BASE_URL       https://dev.toyyibpay.com (sandbox) or https://toyyibpay.com (live)
//   SITE_URL                 https://vespaclubmalaysia.com
// SUPABASE_URL and the project keys are provided by Supabase automatically.
// Optional: VCM_SECRET_KEY (an sb_secret_ key) if Supabase stops providing one.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Keys: works with both the legacy keys (anon / service_role) and the new
// sb_publishable_ / sb_secret_ keys. Supabase provides these automatically.
function firstKey(...names: string[]): string {
  for (const name of names) {
    const raw = Deno.env.get(name);
    if (!raw) continue;
    if (raw.trim().startsWith("{")) {
      // SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS are JSON maps of named keys
      try {
        const map = JSON.parse(raw) as Record<string, string>;
        const value = map["default"] ?? Object.values(map)[0];
        if (value) return value;
      } catch { /* not JSON, ignore */ }
      continue;
    }
    return raw;
  }
  return "";
}
const SERVICE_KEY = firstKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY", "VCM_SECRET_KEY");
const SERVER_PUBLIC_KEY = firstKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const TP_BASE = (Deno.env.get("TOYYIBPAY_BASE_URL") ?? "https://dev.toyyibpay.com").replace(/\/+$/, "");
const TP_SECRET = Deno.env.get("TOYYIBPAY_SECRET_KEY") ?? "";
const TP_CATEGORY = Deno.env.get("TOYYIBPAY_CATEGORY_CODE") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://vespaclubmalaysia.com").replace(/\/+$/, "");

const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  SITE_URL.replace("://", "://www."),
  ...(Deno.env.get("EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : SITE_URL,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });
  if (!TP_SECRET || !TP_CATEGORY) return json(req, 500, { error: "Payment is not set up yet. Please contact the AJK." });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json(req, 401, { error: "Please log in again." });
  // The portal sends the project's public key with every request.
  const publicKey = req.headers.get("apikey") || SERVER_PUBLIC_KEY;
  if (!publicKey || !SERVICE_KEY) return json(req, 500, { error: "Server keys are not configured." });

  // Acts as the member: row level security applies.
  const asMember = createClient(SUPABASE_URL, publicKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Checks the login token with Supabase Auth (works with JWT verification off).
  const { data: userData, error: userError } = await asMember.auth.getUser(authHeader.slice(7));
  if (userError || !userData?.user) return json(req, 401, { error: "Please log in again." });

  const { data: payment, error: startError } = await asMember.rpc("start_renewal");
  if (startError || !payment) {
    return json(req, 400, { error: startError?.message ?? "Renewal is not available right now." });
  }

  const { data: member, error: memberError } = await asMember
    .from("members")
    .select("full_name, phone, email")
    .eq("id", userData.user.id)
    .single();
  if (memberError || !member) return json(req, 400, { error: "Member profile not found." });

  const form = new URLSearchParams({
    userSecretKey: TP_SECRET,
    categoryCode: TP_CATEGORY,
    // ToyyibPay: billName max 30 characters, billDescription max 100
    billName: payment.kind === "new" ? `VCM New Membership ${payment.coverage_year}` : `VCM Renewal ${payment.coverage_year}`,
    billDescription: payment.kind === "new"
      ? `Yuran ahli baharu Vespa Club Malaysia ${payment.coverage_year}`
      : `Yuran pembaharuan keahlian Vespa Club Malaysia ${payment.coverage_year}`,
    billPriceSetting: "1", // fixed amount
    billPayorInfo: "1", // payer details required
    billAmount: String(payment.amount_cents), // in sen
    billReturnUrl: `${SITE_URL}/ahli/?payment=return`,
    billCallbackUrl: `${SUPABASE_URL}/functions/v1/toyyibpay-callback`,
    billExternalReferenceNo: payment.id,
    billTo: member.full_name ?? "",
    billEmail: member.email,
    billPhone: (member.phone ?? "").replace(/\D/g, ""),
    billSplitPayment: "0",
    billSplitPaymentArgs: "",
    billPaymentChannel: "0", // FPX only
    billContentEmail: "Terima kasih kerana memperbaharui keahlian Vespa Club Malaysia.",
    billChargeToCustomer: Deno.env.get("TOYYIBPAY_CHARGE_TO_CUSTOMER") ?? "",
    billExpiryDays: "1",
  });

  let billCode: string | undefined;
  let raw = "";
  try {
    const res = await fetch(`${TP_BASE}/index.php/api/createBill`, { method: "POST", body: form });
    raw = await res.text();
    const parsed = JSON.parse(raw);
    billCode = Array.isArray(parsed) ? parsed[0]?.BillCode : undefined;
  } catch (_err) {
    billCode = undefined;
  }

  if (!billCode) {
    console.error("ToyyibPay createBill failed", raw.slice(0, 500));
    await service.rpc("mark_payment_failed", { p_payment_id: payment.id });
    return json(req, 502, { error: "Could not start the FPX payment. Please try again in a few minutes." });
  }

  const { error: saveError } = await service.from("payments").update({ bill_code: billCode }).eq("id", payment.id);
  if (saveError) {
    console.error("Could not save bill code", saveError.message);
    return json(req, 500, { error: "Could not start the FPX payment. Please try again." });
  }

  return json(req, 200, { url: `${TP_BASE}/${billCode}`, billCode });
});
