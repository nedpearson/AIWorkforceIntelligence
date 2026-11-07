/**
 * POST /api/billing/webhook — Stripe webhook.
 * Verifies the signature with STRIPE_WEBHOOK_SECRET (raw body), then hands the event to handleStripeEvent,
 * which is idempotent on the Stripe event id. Returns 503 when Stripe is not configured, 400 on a bad signature.
 * Events handled: checkout.session.completed, customer.subscription.{created,updated,deleted}, invoice.{paid,payment_failed}.
 */
import { verifyWebhook, handleStripeEvent } from "@/engine/billing";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const raw = await req.text();
  const v = verifyWebhook(raw, req.headers.get("stripe-signature"));
  if (!v.ok) return Response.json({ error: v.reason }, { status: v.status });
  try {
    const out = await handleStripeEvent(v.event);
    return Response.json({ received: true, ...out });
  } catch (e) {
    console.error("stripe webhook failed", e);
    return Response.json({ error: "handler failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
export async function GET() { return Response.json({ ok: true, endpoint: "stripe webhook", method: "POST" }); }
