import type { Env } from "./env";

// Minimal Stripe client using fetch (no SDK needed on Cloudflare Workers).
const API = "https://api.stripe.com/v1";

async function stripe<T>(secret: string, path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
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
  items?: { data: { current_period_end?: number }[] }; // newer API versions
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

export function pricePence(env: Env): number {
  const n = Number.parseInt(env.PRICE_PENCE, 10);
  return Number.isFinite(n) && n >= 30 ? n : 1000;
}

export async function createSubscriptionCheckout(
  env: Env,
  opts: { origin: string; userId: number; email: string; customerId: string | null; appName: string }
): Promise<CheckoutSession> {
  const b = new URLSearchParams();
  b.set("mode", "subscription");
  b.set("client_reference_id", String(opts.userId));
  if (opts.customerId) b.set("customer", opts.customerId);
  else b.set("customer_email", opts.email);
  b.set("success_url", `${opts.origin}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  b.set("cancel_url", `${opts.origin}/dashboard?checkout=cancelled`);
  b.set("line_items[0][quantity]", "1");
  if (env.STRIPE_PRICE_ID?.trim()) {
    b.set("line_items[0][price]", env.STRIPE_PRICE_ID.trim());
  } else {
    b.set("line_items[0][price_data][currency]", "gbp");
    b.set("line_items[0][price_data][unit_amount]", String(pricePence(env)));
    b.set("line_items[0][price_data][recurring][interval]", "month");
    b.set("line_items[0][price_data][product_data][name]", `${opts.appName} host account`);
    b.set("line_items[0][price_data][product_data][description]", "Host video meetings: monthly subscription, cancel any time");
  }
  b.set("subscription_data[metadata][user_id]", String(opts.userId));
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
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
  if (!ok) return null;
  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    return null;
  }
}
