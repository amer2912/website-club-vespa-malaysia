// Supabase Edge Function: create-bill
// Starts an FPX membership payment (new member or renewal) for the logged-in
// member, through ToyyibPay or Billplz.
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
//
// Billplz (used when MEMBERSHIP_GATEWAY = billplz; needs SQL 017):
//   MEMBERSHIP_GATEWAY       billplz | toyyibpay (default toyyibpay)
//   BILLPLZ_API_KEY          API Secret Key (Billplz -> Settings -> Keys & Integration)
//   BILLPLZ_COLLECTION_ID    the collection that membership bills go into
//   BILLPLZ_BASE_URL         https://www.billplz.com (live) or https://www.billplz-sandbox.com
//   (BILLPLZ_X_SIGNATURE_KEY is used by billplz-callback)
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
const GATEWAY = (Deno.env.get("MEMBERSHIP_GATEWAY") ?? "toyyibpay").trim().toLowerCase() === "billplz" ? "billplz" : "toyyibpay";
const BP_KEY = Deno.env.get("BILLPLZ_API_KEY") ?? "";
const BP_COLLECTION = Deno.env.get("BILLPLZ_COLLECTION_ID") ?? "";
const BP_BASE = (Deno.env.get("BILLPLZ_BASE_URL") ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
const bpAuth = () => "Basic " + btoa(`${BP_KEY}:`);
// Billplz wants a Malaysian mobile as 60XXXXXXXXX; anything else is left out (email is enough).
function bpMobile(phone: string | null): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "6" + d;
  return /^601\d{8,9}$/.test(d) ? d : "";
}

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
  if (GATEWAY === "billplz" ? !BP_KEY || !BP_COLLECTION || !BP_BASE : !TP_SECRET || !TP_CATEGORY) {
    return json(req, 500, { error: "Payment is not set up yet. Please contact the AJK." });
  }

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

  if (GATEWAY === "billplz") return billplzBill(req, service, payment, member, userData.user.id);

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
    // 0 = FPX only (default), 1 = card only, 2 = FPX and card. Card needs to be
    // enabled on the ToyyibPay account first.
    billPaymentChannel: ["0", "1", "2"].includes(Deno.env.get("TOYYIBPAY_PAYMENT_CHANNEL") ?? "")
      ? Deno.env.get("TOYYIBPAY_PAYMENT_CHANNEL")!
      : "0",
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
  // Which gateway (SQL 017). Ignored if the column does not exist yet.
  await service.from("payments").update({ provider: "toyyibpay" }).eq("id", payment.id);

  return json(req, 200, { url: `${TP_BASE}/${billCode}`, billCode });
});

type Payment = { id: string; kind: string; coverage_year: number; amount_cents: number };
type Member = { full_name: string | null; phone: string | null; email: string };

// Billplz: cancel the member's older unpaid Billplz bills (so the same year
// cannot be paid twice), then create the new bill.
// deno-lint-ignore no-explicit-any
async function billplzBill(req: Request, service: any, payment: Payment, member: Member, memberId: string): Promise<Response> {
  const { data: older } = await service.from("payments").select("id, bill_code")
    .eq("member_id", memberId).eq("status", "pending").eq("provider", "billplz").neq("id", payment.id);
  for (const o of older ?? []) {
    if (!o.bill_code) continue;
    try {
      const res = await fetch(`${BP_BASE}/api/v3/bills/${encodeURIComponent(o.bill_code)}`, { method: "DELETE", headers: { Authorization: bpAuth() } });
      if (res.ok) await service.rpc("mark_payment_failed", { p_payment_id: o.id });
    } catch (err) {
      console.error("Billplz delete failed", o.bill_code, String(err));
    }
  }

  const isNew = payment.kind === "new";
  const form = new URLSearchParams({
    collection_id: BP_COLLECTION,
    email: member.email,
    name: (member.full_name ?? member.email).slice(0, 255),
    amount: String(payment.amount_cents), // in sen
    description: (isNew
      ? `Yuran ahli baharu Vespa Club Malaysia ${payment.coverage_year}`
      : `Yuran pembaharuan keahlian Vespa Club Malaysia ${payment.coverage_year}`).slice(0, 200),
    callback_url: `${SUPABASE_URL}/functions/v1/billplz-callback`,
    redirect_url: `${SITE_URL}/ahli/`,
    reference_1_label: "Payment",
    reference_1: payment.id,
    reference_2_label: "Membership",
    reference_2: `${isNew ? "New" : "Renewal"} ${payment.coverage_year}`,
    deliver: "false",
  });
  const mobile = bpMobile(member.phone);
  if (mobile) form.set("mobile", mobile);

  let bill: { id?: string; url?: string } = {};
  let raw = "";
  try {
    const res = await fetch(`${BP_BASE}/api/v3/bills`, { method: "POST", headers: { Authorization: bpAuth() }, body: form });
    raw = await res.text();
    if (res.ok) bill = JSON.parse(raw);
  } catch (err) {
    raw = String(err);
  }
  if (!bill.id || !bill.url) {
    console.error("Billplz create bill failed", raw.slice(0, 500));
    await service.rpc("mark_payment_failed", { p_payment_id: payment.id });
    return json(req, 502, { error: "Could not start the FPX payment. Please try again in a few minutes." });
  }

  const { error: saveError } = await service.from("payments").update({ bill_code: bill.id, provider: "billplz" }).eq("id", payment.id);
  if (saveError) {
    console.error("Could not save Billplz bill", saveError.message);
    return json(req, 500, { error: "Could not start the FPX payment. Please try again." });
  }
  return json(req, 200, { url: bill.url, billCode: bill.id, gateway: "billplz" });
}
