// Supabase Edge Function: billplz-callback
// Billplz calls this (callback_url) after a membership bill is paid. The
// member portal also calls it with { id } when the member comes back from
// Billplz, so the status updates at once.
//
// Nothing posted here is trusted: the bill is fetched again from the Billplz
// API with our API key, and only a paid bill for the same payment and the
// exact amount activates the membership. When BILLPLZ_X_SIGNATURE_KEY is set,
// the X Signature of a Billplz callback is also checked and logged.
// Deploy with JWT verification turned OFF (Billplz cannot send a login token).
//
// Secrets: BILLPLZ_API_KEY, BILLPLZ_BASE_URL, BILLPLZ_X_SIGNATURE_KEY (optional).
// Needs SQL 017 (payments.provider).

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
const BP_KEY = Deno.env.get("BILLPLZ_API_KEY") ?? "";
const BP_BASE = (Deno.env.get("BILLPLZ_BASE_URL") ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
const BP_XKEY = Deno.env.get("BILLPLZ_X_SIGNATURE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Billplz X Signature: every field except x_signature as key+value, sorted
// case-insensitively, joined with "|", HMAC-SHA256 with the X Signature Key (hex).
export async function xSignature(fields: Record<string, string>, key: string): Promise<string> {
  const source = Object.entries(fields)
    .filter(([k]) => k !== "x_signature")
    .map(([k, v]) => `${k}${v}`)
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    .join("|");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(source));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readFields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await req.json();
      return Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, String(v ?? "")]));
    }
    const form = await req.formData();
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

type BillplzBill = { id?: string; paid?: boolean; state?: string; paid_amount?: number; amount?: number; reference_1?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  if (!SERVICE_KEY || !BP_KEY || !BP_BASE) return reply(500, { error: "Billplz is not set up." });

  const fields = await readFields(req);
  const billId = (fields.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(billId)) return reply(400, { error: "Missing bill id" });

  if (fields.x_signature && BP_XKEY) {
    const expected = await xSignature(fields, BP_XKEY);
    if (expected !== fields.x_signature) console.warn("Billplz X Signature mismatch, confirming with the API anyway", billId);
  }

  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: payment, error: findError } = await service
    .from("payments")
    .select("id, amount_cents, status")
    .eq("bill_code", billId)
    .eq("provider", "billplz")
    .maybeSingle();
  if (findError) return reply(500, { error: "Lookup failed" });
  if (!payment) return reply(404, { error: "Unknown bill" });
  if (payment.status === "paid") return reply(200, { status: "paid" });

  let bill: BillplzBill = {};
  try {
    const res = await fetch(`${BP_BASE}/api/v3/bills/${encodeURIComponent(billId)}`, {
      headers: { Authorization: "Basic " + btoa(`${BP_KEY}:`) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bill = await res.json();
  } catch (err) {
    console.error("Billplz get bill failed", billId, String(err));
    return reply(502, { error: "Could not confirm with Billplz" });
  }

  if (bill.paid === true && bill.state === "paid") {
    if (bill.reference_1 && bill.reference_1 !== payment.id) {
      console.error("Reference mismatch", billId, bill.reference_1, payment.id);
      return reply(409, { error: "Reference mismatch" });
    }
    const { error } = await service.rpc("mark_payment_paid", {
      p_payment_id: payment.id,
      p_provider_ref: `billplz:${billId}`,
      p_amount_cents: Number(bill.paid_amount ?? bill.amount ?? 0),
    });
    if (error) {
      console.error("mark_payment_paid failed", error.message);
      return reply(500, { error: "Could not activate membership" });
    }
    return reply(200, { status: "paid" });
  }

  if (bill.state === "deleted") {
    await service.rpc("mark_payment_failed", { p_payment_id: payment.id });
    return reply(200, { status: "failed" });
  }
  return reply(200, { status: "pending" });
});
