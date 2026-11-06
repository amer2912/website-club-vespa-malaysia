// Supabase Edge Function: toyyibpay-callback
// ToyyibPay calls this after a payment. The member portal also calls it when
// the member comes back from the payment page, so the status updates at once.
//
// The data posted here is never trusted: the bill is looked up again with
// ToyyibPay (getBillTransactions) and only a confirmed, matching amount
// activates the membership. Deploy with JWT verification turned OFF, because
// ToyyibPay cannot send a Supabase login token.
//
// Secret: TOYYIBPAY_BASE_URL (same as create-bill).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TP_BASE = (Deno.env.get("TOYYIBPAY_BASE_URL") ?? "https://dev.toyyibpay.com").replace(/\/+$/, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type ToyyibTransaction = {
  billpaymentStatus?: string | number; // "1" success, "2" pending, "3" failed
  billpaymentAmount?: string; // "50.00"
  billpaymentInvoiceNo?: string;
  billExternalReferenceNo?: string;
};

async function readBillCode(req: Request): Promise<string | null> {
  const type = req.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await req.json();
      return body?.billcode ?? body?.billCode ?? null;
    }
    const form = await req.formData();
    return (form.get("billcode") ?? form.get("billCode"))?.toString() ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const billCode = (await readBillCode(req))?.trim();
  if (!billCode || !/^[A-Za-z0-9]{4,32}$/.test(billCode)) return reply(400, { error: "Missing bill code" });

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: payment, error: findError } = await service
    .from("payments")
    .select("id, amount_cents, status")
    .eq("bill_code", billCode)
    .maybeSingle();
  if (findError) return reply(500, { error: "Lookup failed" });
  if (!payment) return reply(404, { error: "Unknown bill" });
  if (payment.status === "paid") return reply(200, { status: "paid" });

  let transactions: ToyyibTransaction[] = [];
  try {
    const res = await fetch(`${TP_BASE}/index.php/api/getBillTransactions`, {
      method: "POST",
      body: new URLSearchParams({ billCode }),
    });
    const parsed = await res.json();
    transactions = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("getBillTransactions failed", String(err));
    return reply(502, { error: "Could not confirm with ToyyibPay" });
  }

  const paid = transactions.find((t) => String(t.billpaymentStatus) === "1");
  if (paid) {
    if (paid.billExternalReferenceNo && paid.billExternalReferenceNo !== payment.id) {
      console.error("Reference mismatch", billCode, paid.billExternalReferenceNo, payment.id);
      return reply(409, { error: "Reference mismatch" });
    }
    const amountCents = Math.round(parseFloat(paid.billpaymentAmount ?? "0") * 100);
    const { error } = await service.rpc("mark_payment_paid", {
      p_payment_id: payment.id,
      p_provider_ref: paid.billpaymentInvoiceNo ?? billCode,
      p_amount_cents: amountCents,
    });
    if (error) {
      console.error("mark_payment_paid failed", error.message);
      return reply(500, { error: "Could not activate membership" });
    }
    return reply(200, { status: "paid" });
  }

  if (transactions.length > 0 && transactions.every((t) => String(t.billpaymentStatus) === "3")) {
    await service.rpc("mark_payment_failed", { p_payment_id: payment.id });
    return reply(200, { status: "failed" });
  }

  return reply(200, { status: "pending" });
});
