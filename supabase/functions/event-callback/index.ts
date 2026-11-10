// Supabase Edge Function: event-callback
// ToyyibPay calls this after an event ticket payment. The ticket page also
// calls it when the buyer comes back from the payment page.
//
// The posted data is never trusted: the bill is checked again with ToyyibPay
// (getBillTransactions) and only a confirmed payment of the exact amount, for
// this order, marks the ticket paid. Deploy with JWT verification turned OFF.
//
// Secret: TOYYIBPAY_BASE_URL (same as event-checkout).

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function firstKey(...names: string[]): string {
  for (const name of names) {
    const raw = Deno.env.get(name);
    if (!raw) continue;
    if (raw.trim().startsWith("{")) {
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
  billpaymentAmount?: string;
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
  if (!SERVICE_KEY) return reply(500, { error: "Server keys are not configured." });

  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: order, error: findError } = await service
    .from("event_orders")
    .select("id, amount_cents, status")
    .eq("bill_code", billCode)
    .maybeSingle();
  if (findError) return reply(500, { error: "Lookup failed" });
  if (!order) return reply(404, { error: "Unknown bill" });
  if (order.status === "paid") return reply(200, { status: "paid" });

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
    if (paid.billExternalReferenceNo && paid.billExternalReferenceNo !== order.id) {
      console.error("Reference mismatch", billCode);
      return reply(409, { error: "Reference mismatch" });
    }
    const amountCents = Math.round(parseFloat(paid.billpaymentAmount ?? "0") * 100);
    const { error } = await service.rpc("event_mark_paid", {
      p_order: order.id,
      p_provider_ref: paid.billpaymentInvoiceNo ?? billCode,
      p_amount_cents: amountCents,
    });
    if (error) {
      console.error("event_mark_paid failed", error.message);
      return reply(500, { error: "Could not confirm the ticket" });
    }
    return reply(200, { status: "paid" });
  }

  if (transactions.length > 0 && transactions.every((t) => String(t.billpaymentStatus) === "3")) {
    await service.rpc("event_mark_failed", { p_order: order.id });
    return reply(200, { status: "failed" });
  }
  return reply(200, { status: "pending" });
});
