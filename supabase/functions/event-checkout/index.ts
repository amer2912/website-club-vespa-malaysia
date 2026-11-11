// Supabase Edge Function: event-checkout
// Public ticket checkout for events sold on the club website (no login).
// Creates a pending order in the database, then a ToyyibPay bill on the
// ORGANISER's ToyyibPay account, so the money goes straight to them.
//
// Deploy with JWT verification turned OFF (buyers do not log in).
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   EVENT_TOYYIBPAY_<NAME>  the organiser's ToyyibPay user secret key; the
//                           events row names which secret to use
//   TOYYIBPAY_BASE_URL      https://toyyibpay.com (live) or https://dev.toyyibpay.com
//   SITE_URL                https://vespaclubmalaysia.com
// SUPABASE_URL and the project keys are provided by Supabase automatically.

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
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });
  if (!SERVICE_KEY) return json(req, 500, { error: "Server keys are not configured." });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: "Invalid request." });
  }
  const eventId = text(body.event, 40);
  if (!/^[a-z0-9-]{3,40}$/.test(eventId)) return json(req, 400, { error: "Unknown event." });

  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: event, error: eventError } = await service
    .from("events")
    .select("id, title, venue, bill_name, toyyibpay_secret_name, toyyibpay_category_code, payment_channel")
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) return json(req, 500, { error: "Could not load the event." });
  if (!event) return json(req, 404, { error: "Unknown event." });

  const secretName = event.toyyibpay_secret_name ?? "";
  const tpSecret = /^EVENT_TOYYIBPAY_[A-Z0-9_]{1,40}$/.test(secretName) ? Deno.env.get(secretName) ?? "" : "";
  if (!tpSecret || !event.toyyibpay_category_code) {
    return json(req, 503, { error: "Ticket payment is not open yet. Please try again later." });
  }

  // All checks (open, sales close, size stock, limits) happen in the database.
  const { data: order, error: orderError } = await service.rpc("event_start_order", {
    p_event: eventId,
    p_full_name: text(body.full_name, 120),
    p_phone: text(body.phone, 20),
    p_email: text(body.email, 200),
    p_moto_type: text(body.moto_type, 40),
    p_moto_model: text(body.moto_model, 80),
    p_size: text(body.shirt_size, 10),
    // optional survey ("interested in"); the database keeps only the event's own options
    p_interests: Array.isArray(body.interests) ? body.interests.slice(0, 10).map((v) => text(v, 80)).filter(Boolean) : [],
  });
  if (orderError || !order) return json(req, 400, { error: orderError?.message ?? "Could not create the order." });

  const ticketUrl = `${SITE_URL}/acara/tiket.html?code=${order.ticket_code}`;
  const form = new URLSearchParams({
    userSecretKey: tpSecret,
    categoryCode: event.toyyibpay_category_code,
    billName: event.bill_name.slice(0, 30),
    billDescription: `${event.title} · Saiz baju ${order.shirt_size}`.slice(0, 100),
    billPriceSetting: "1",
    billPayorInfo: "1",
    billAmount: String(order.amount_cents),
    billReturnUrl: ticketUrl,
    billCallbackUrl: `${SUPABASE_URL}/functions/v1/event-callback`,
    billExternalReferenceNo: order.id,
    billTo: order.full_name,
    billEmail: order.email,
    billPhone: order.phone.replace(/\D/g, ""),
    billSplitPayment: "0",
    billSplitPaymentArgs: "",
    billPaymentChannel: event.payment_channel ?? "0",
    billContentEmail:
      `Terima kasih! Tiket dan kod QR anda: ${ticketUrl} . Tunjukkan kod QR ini di kaunter pada hari acara untuk ambil baju. ` +
      `Thank you! Your ticket and QR code: ${ticketUrl}`,
    billChargeToCustomer: "",
    billExpiryDays: "1",
  });

  let billCode: string | undefined;
  let raw = "";
  try {
    const res = await fetch(`${TP_BASE}/index.php/api/createBill`, { method: "POST", body: form });
    raw = await res.text();
    const parsed = JSON.parse(raw);
    billCode = Array.isArray(parsed) ? parsed[0]?.BillCode : undefined;
  } catch {
    billCode = undefined;
  }
  if (!billCode) {
    console.error("ToyyibPay createBill failed", eventId, raw.slice(0, 300));
    await service.rpc("event_mark_failed", { p_order: order.id });
    return json(req, 502, { error: "Could not start the payment. Please try again in a few minutes." });
  }

  const { error: saveError } = await service.from("event_orders").update({ bill_code: billCode }).eq("id", order.id);
  if (saveError) {
    console.error("Could not save bill code", saveError.message);
    return json(req, 500, { error: "Could not start the payment. Please try again." });
  }
  return json(req, 200, { url: `${TP_BASE}/${billCode}`, ticket: order.ticket_code });
});
