// Supabase Edge Function: event-checkout
// Public ticket checkout for events sold on the club website (no login).
// Creates a pending order in the database, then a ToyyibPay bill on the
// ORGANISER's ToyyibPay account, so the money goes straight to them.
//
// Deploy with JWT verification turned OFF (buyers do not have to log in).
// Member price: when the buyer ticks "member price", the request carries
// their member-portal login; it is verified here with Supabase Auth and the
// database decides whether the member qualifies (active on the event date,
// profile complete, one member-price order per event).
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   EVENT_TOYYIBPAY_<NAME>  the organiser's ToyyibPay user secret key; the
//                           events row names which secret to use
//   TOYYIBPAY_BASE_URL      https://toyyibpay.com (live) or https://dev.toyyibpay.com
//   SITE_URL                https://vespaclubmalaysia.com
//   EVENT_DUITNOW_QR        optional: event ids (comma separated) whose bills
//                           also offer DuitNow QR. Default "vespa-day-2026"
//                           (VCM's ToyyibPay account, DNQR approved). Set to
//                           "none" to turn it off for every event.
//   EVENT_CHARGE_DUITNOW_QR optional: "1" buyer pays the DuitNow QR fee,
//                           "0" (default) the account owner pays
//                           Keep "0": the callback checks the paid amount equals the
//                           price, and a buyer-paid fee could make it differ.
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
// DuitNow QR only for events whose ToyyibPay account has DNQR approved.
const DUITNOW_EVENTS = new Set((Deno.env.get("EVENT_DUITNOW_QR") ?? "vespa-day-2026").split(",").map((s) => s.trim()).filter(Boolean));
const DUITNOW_CHARGE = Deno.env.get("EVENT_CHARGE_DUITNOW_QR") === "1" ? "1" : "0";
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

  // Member price: only when asked for, and only with a valid member-portal login.
  let memberUser: string | null = null;
  if (body.use_member === true) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: who } = token ? await service.auth.getUser(token) : { data: { user: null } };
    if (!who?.user?.id) {
      return json(req, 401, { error: "Please log in to the member portal again to get the member price." });
    }
    memberUser = who.user.id;
  }

  // All checks (open, sales close, size stock, limits, member price) happen in the database.
  const { data: order, error: orderError } = await service.rpc("event_start_order", {
    p_event: eventId,
    p_full_name: text(body.full_name, 120),
    p_phone: text(body.phone, 20),
    p_email: text(body.email, 200),
    p_moto_type: text(body.moto_type, 40),
    p_moto_model: text(body.moto_model, 80),
    p_size: text(body.shirt_size, 10),
    // optional survey ("interested in"); the database keeps only the event's own options
    p_size_note: text(body.size_note, 100),
    p_interests: Array.isArray(body.interests) ? body.interests.slice(0, 10).map((v) => text(v, 80)).filter(Boolean) : [],
    p_member_user: memberUser,
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
      `Terima kasih! Tiket dan kod QR anda: ${ticketUrl} . Tunjukkan kod QR ini di kaunter pada hari acara untuk ambil baju / pek anda. ` +
      `Thank you! Your ticket and QR code: ${ticketUrl}`,
    billChargeToCustomer: "",
    billExpiryDays: "1",
  });

  const createBill = async (f: URLSearchParams) => {
    try {
      const res = await fetch(`${TP_BASE}/index.php/api/createBill`, { method: "POST", body: f });
      const raw = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
      return { billCode: Array.isArray(parsed) ? (parsed[0] as { BillCode?: string })?.BillCode : undefined, raw };
    } catch (err) {
      return { billCode: undefined, raw: String(err) };
    }
  };
  const withQr = DUITNOW_EVENTS.has(eventId);
  let { billCode, raw } = await createBill(withQr
    ? new URLSearchParams([...form, ["enableDuitNowQR", "1"], ["chargeDuitNowQR", DUITNOW_CHARGE]])
    : form);
  if (!billCode && withQr) {
    // DuitNow QR refused by ToyyibPay: never block a sale, retry with FPX only.
    console.error("ToyyibPay createBill with DuitNow QR failed, retrying without", eventId, raw.slice(0, 300));
    ({ billCode, raw } = await createBill(form));
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
