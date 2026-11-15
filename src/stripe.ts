import { hmacHex, safeEqual } from "./crypto";
import type { Env } from "./env";
import { businessPricePence, proPricePence, type PaidPlan } from "./plans";

// Minimal Stripe client using fetch (no SDK needed on Cloudflare Workers).
const API = "https://api.stripe.com/v1";

async function stripe<T>(secret: string, path: string, body?: URLSearchParams, idempotencyKey?: string, method?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe error ${res.status}`);
  return json;
}

export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number; // older API versions
  items?: { data: { id?: string; quantity?: number; current_period_end?: number }[] }; // newer API versions
  metadata?: Record<string, string>;
};

export type CheckoutSession = {
  id: string;
  url: string | null;
  mode: string;
  status: string | null;
  customer: string | null;
  subscription: string | null;
  client_reference_id: string | null;
};

/** The plan a Stripe subscription is for (set when it was bought). */
export const planOf = (sub: StripeSubscription): PaidPlan => (sub.metadata?.plan === "business" ? "business" : "pro");

/** How many seats a subscription pays for (Business is charged per seat). */
export const seatsOf = (sub: StripeSubscription): number => Math.max(1, sub.items?.data?.[0]?.quantity ?? 1);

/** Changes the number of seats on a Business subscription. Stripe charges or credits the difference pro rata. */
export async function setSeats(env: Env, subId: string, seats: number): Promise<StripeSubscription> {
  const sub = await retrieveSubscription(env, subId);
  const item = sub.items?.data?.[0]?.id;
  if (!item) throw new Error("subscription has no item");
  const b = new URLSearchParams();
  b.set("items[0][id]", item);
  b.set("items[0][quantity]", String(seats));
  b.set("proration_behavior", "create_prorations");
  return stripe<StripeSubscription>(env.STRIPE_SECRET_KEY!, `/subscriptions/${encodeURIComponent(subId)}`, b);
}

/** Cancels a subscription now, crediting the unused time to the customer (used when upgrading Pro to Business). */
export async function cancelSubscriptionNow(env: Env, id: string): Promise<void> {
  const b = new URLSearchParams({ prorate: "true" });
  await stripe(env.STRIPE_SECRET_KEY!, `/subscriptions/${encodeURIComponent(id)}`, b, undefined, "DELETE");
}

export async function createSubscriptionCheckout(
  env: Env,
  opts: { origin: string; userId: number; email: string; customerId: string | null; appName: string; plan: PaidPlan; seats: number }
): Promise<CheckoutSession> {
  const pro = opts.plan === "pro";
  const priceId = (pro ? env.STRIPE_PRO_PRICE_ID : env.STRIPE_BUSINESS_PRICE_ID)?.trim();
  const b = new URLSearchParams();
  b.set("mode", "subscription");
  b.set("client_reference_id", String(opts.userId));
  if (opts.customerId) b.set("customer", opts.customerId);
  else b.set("customer_email", opts.email);
  b.set("success_url", `${opts.origin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  b.set("cancel_url", `${opts.origin}/dashboard?checkout=cancelled`);
  b.set("line_items[0][quantity]", String(pro ? 1 : Math.max(1, opts.seats)));
  if (priceId) {
    b.set("line_items[0][price]", priceId);
  } else {
    b.set("line_items[0][price_data][currency]", "gbp");
    b.set("line_items[0][price_data][unit_amount]", String(pro ? proPricePence(env) : businessPricePence(env)));
    b.set("line_items[0][price_data][recurring][interval]", "month");
    b.set("line_items[0][price_data][product_data][name]", pro ? `${opts.appName} Pro` : `${opts.appName} Business (per user)`);
    b.set(
      "line_items[0][price_data][product_data][description]",
      pro ? "Meetings for up to 15 people with your own link, waiting room and after-call page: monthly, cancel any time" : "Meetings for up to 50 people with your branding, the API and a team: monthly per user, cancel any time"
    );
  }
  b.set("subscription_data[metadata][user_id]", String(opts.userId));
  b.set("subscription_data[metadata][plan]", opts.plan);
  b.set("allow_promotion_codes", "true");
  return stripe<CheckoutSession>(env.STRIPE_SECRET_KEY!, "/checkout/sessions", b);
}

export const retrieveCheckout = (env: Env, id: string) =>
  stripe<CheckoutSession>(env.STRIPE_SECRET_KEY!, `/checkout/sessions/${encodeURIComponent(id)}`);

export const retrieveSubscription = (env: Env, id: string) =>
  stripe<StripeSubscription>(env.STRIPE_SECRET_KEY!, `/subscriptions/${encodeURIComponent(id)}`);

export async function createPortalSession(env: Env, customerId: string, returnUrl: string): Promise<string> {
  const b = new URLSearchParams({ customer: customerId, return_url: returnUrl });
  const s = await stripe<{ url: string }>(env.STRIPE_SECRET_KEY!, "/billing_portal/sessions", b);
  return s.url;
}

export function periodEndMs(sub: StripeSubscription): number | null {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof s === "number" ? s * 1000 : null;
}

export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/** Verifies the `Stripe-Signature` header (HMAC-SHA256, 5 minute tolerance). */
export async function verifyWebhook(rawBody: string, header: string | null, secret: string): Promise<StripeEvent | null> {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0) return null;
  if (!/^\d+$/.test(t) || Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  if (!sigs.some((s) => safeEqual(s, expected))) return null;
  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    return null;
  }
}
