import {
  SESSION_COOKIE,
  SESSION_S,
  fakeVerify,
  hashPassword,
  makeSession,
  participantId,
  passwordFingerprint,
  randomId,
  randomToken,
  readSession,
  sha256Hex,
  signJoin,
  verifyInvite,
  verifyPassword,
} from "./crypto";
import { formatWhen, inviteEmail, passwordChangedEmail, resetEmail, sendEmail, verifyEmail } from "./email";
import type { Env } from "./env";
import { getIce } from "./ice";
import { handleV1 } from "./v1";
import { rtkConfigured, rtkMax } from "./realtimekit";
import { clearHits, isLimited, recordHit } from "./ratelimit";
import {
  createPortalSession,
  createSubscriptionCheckout,
  periodEndMs,
  pricePence,
  retrieveCheckout,
  retrieveSubscription,
  verifyWebhook,
  type StripeSubscription,
} from "./stripe";

export type UserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  email_verified: number;
  personal_room: string;
  stripe_customer_id: string | null;
  stripe_sub_id: string | null;
  sub_status: string;
  sub_period_end: number | null;
  sub_cancel_at_end: number;
};

export type Ctx = { req: Request; env: Env; url: URL; wait: (p: Promise<unknown>) => void };

export const OPEN_BEFORE_MS = 15 * 60_000;
export const GRACE_AFTER_MS = 60 * 60_000;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- small helpers ---------- */

/** The site's own address for links in emails and API answers: PUBLIC_URL if set, else the address this request came to. */
export function origin(c: Ctx): string {
  const p = c.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return p && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(p) ? p : c.url.origin;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    if (Number(req.headers.get("Content-Length") ?? 0) > 20_000) return {};
    const text = await req.text();
    if (text.length > 20_000) return {};
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");
export const ip = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

function setSession(url: URL, value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;
}

async function getUser(c: Ctx): Promise<UserRow | null> {
  if (!c.env.SESSION_SECRET) return null;
  const s = await readSession(c.env.SESSION_SECRET, readCookie(c.req, SESSION_COOKIE));
  if (!s) return null;
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(s.id).first<UserRow>();
  if (!row || (await passwordFingerprint(row.password_hash)) !== s.fp) return null;
  return row;
}

export const isSubscribed = (env: Env, u: Pick<UserRow, "sub_status">) =>
  env.DEV_SKIP_BILLING === "1" || u.sub_status === "active" || u.sub_status === "trialing";

export function priceLabel(env: Env): string {
  const p = pricePence(env) / 100;
  return `£${Number.isInteger(p) ? p : p.toFixed(2)}/month`;
}

function publicUser(env: Env, u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    verified: !!u.email_verified,
    personalRoom: u.personal_room,
    subscribed: isSubscribed(env, u),
    subStatus: u.sub_status,
    periodEnd: u.sub_period_end,
    cancelAtEnd: !!u.sub_cancel_at_end,
    hasCustomer: !!u.stripe_customer_id,
    price: priceLabel(env),
  };
}

async function issueToken(db: D1Database, userId: number, kind: "reset" | "verify", ttlMs: number): Promise<string> {
  const token = randomToken();
  await db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND kind = ?2").bind(userId, kind).run();
  await db
    .prepare("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256Hex(token), userId, kind, Date.now() + ttlMs)
    .run();
  return token;
}

/** Uses up a one-time emailed token. Deleting and reading in one statement means a link can only ever work once. */
async function takeToken(db: D1Database, token: string, kind: "reset" | "verify"): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("DELETE FROM email_tokens WHERE token_hash = ?1 AND kind = ?2 RETURNING user_id, expires_at")
    .bind(hash, kind)
    .first<{ user_id: number; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return row.user_id;
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz.length > 0 && tz.length < 60;
  } catch {
    return false;
  }
}

export const windowState = (startsAt: number, durationMin: number, now = Date.now()) =>
  now < startsAt - OPEN_BEFORE_MS ? "early" : now > startsAt + durationMin * 60_000 + GRACE_AFTER_MS ? "over" : "open";

export function parseEmails(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,;]+/) : [];
  return [...new Set(raw.map((e) => e.trim().toLowerCase()).filter((e) => e && e.length <= 254))];
}

/* ---------- accounts ---------- */

async function signup(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  if (str(b.website, 100)) return fail("Sorry, that didn't work.");
  const db = c.env.DB;
  const key = `signup:${ip(c.req)}`;
  if (await isLimited(db, key, 5, 3600_000)) return fail("Too many sign-ups from this network. Please try again later.", 429);

  const name = str(b.name, 80);
  const email = str(b.email, 254).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  if (!name) return fail("Please enter your name.");
  if (!EMAIL_RE.test(email)) return fail("Please enter a valid email address.");
  if (password.length < 8) return fail("Your password needs at least 8 characters.");
  if (password.length > 200) return fail("That password is too long.");
  if (b.consent !== true) return fail("Please tick the box to accept the terms.");
  await recordHit(db, key);

  if (await db.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first()) {
    return fail("That email already has an account. Try logging in instead.", 409);
  }
  const hash = await hashPassword(password);
  let userId = 0;
  for (let attempt = 0; attempt < 3 && !userId; attempt++) {
    try {
      const r = await db
        .prepare("INSERT INTO users (email, name, password_hash, personal_room, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(email, name, hash, randomId(12), Date.now())
        .run();
      userId = Number(r.meta.last_row_id);
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err;
      if (await db.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first()) {
        return fail("That email already has an account. Try logging in instead.", 409);
      }
    }
  }
  if (!userId) return fail("Sorry, we couldn't create your account. Please try again.", 500);

  const token = await issueToken(db, userId, "verify", 48 * 3600_000);
  c.wait(sendEmail(c.env, verifyEmail(c.env.APP_NAME, email, name, `${origin(c)}/verify?token=${token}`)));
  return json({ ok: true }, 200, { "Set-Cookie": setSession(c.url, await makeSession(c.env.SESSION_SECRET, userId, hash), SESSION_S) });
}

async function login(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const db = c.env.DB;
  const email = str(b.email, 254).toLowerCase();
  const password = typeof b.password === "string" ? b.password.slice(0, 200) : "";
  const kIp = `login:ip:${ip(c.req)}`;
  const kEmail = `login:email:${email}`;
  if ((await isLimited(db, kIp, 10, 15 * 60_000)) || (await isLimited(db, kEmail, 8, 15 * 60_000))) {
    return fail("Too many attempts. Please try again in 15 minutes.", 429);
  }
  const row = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first<UserRow>();
  const ok = row ? await verifyPassword(password, row.password_hash) : (await fakeVerify(password), false);
  if (!row || !ok) {
    await recordHit(db, kIp);
    await recordHit(db, kEmail);
    return fail("Incorrect email or password.", 401);
  }
  await clearHits(db, kEmail);
  return json({ ok: true }, 200, { "Set-Cookie": setSession(c.url, await makeSession(c.env.SESSION_SECRET, row.id, row.password_hash), SESSION_S) });
}

async function resendVerify(c: Ctx, u: UserRow): Promise<Response> {
  if (u.email_verified) return json({ ok: true });
  const key = `verify:${u.id}`;
  if (await isLimited(c.env.DB, key, 3, 3600_000)) return fail("Please wait a while before asking for another email.", 429);
  await recordHit(c.env.DB, key);
  const token = await issueToken(c.env.DB, u.id, "verify", 48 * 3600_000);
  c.wait(sendEmail(c.env, verifyEmail(c.env.APP_NAME, u.email, u.name, `${origin(c)}/verify?token=${token}`)));
  return json({ ok: true });
}

async function verify(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const userId = await takeToken(c.env.DB, str(b.token, 100), "verify");
  if (!userId) return fail("This link has expired or was already used. Log in and ask for a new one.", 410);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?1").bind(userId),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND kind = 'verify'").bind(userId),
  ]);
  return json({ ok: true });
}

async function forgot(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const db = c.env.DB;
  const email = str(b.email, 254).toLowerCase();
  const generic = json({ ok: true }); // never reveals whether an account exists
  if (str(b.website, 100) || !EMAIL_RE.test(email)) return generic;
  const kIp = `forgot:ip:${ip(c.req)}`;
  const kEmail = `forgot:email:${email}`;
  if ((await isLimited(db, kIp, 5, 3600_000)) || (await isLimited(db, kEmail, 3, 3600_000))) return generic;
  await recordHit(db, kIp);
  await recordHit(db, kEmail);
  c.wait(
    (async () => {
      const u = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first<UserRow>();
      if (!u) return;
      const token = await issueToken(db, u.id, "reset", 3600_000);
      await sendEmail(c.env, resetEmail(c.env.APP_NAME, u.email, u.name, `${origin(c)}/reset?token=${token}`));
    })()
  );
  return generic;
}

async function resetPassword(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const db = c.env.DB;
  const key = `reset:ip:${ip(c.req)}`;
  if (await isLimited(db, key, 10, 3600_000)) return fail("Too many attempts. Please try again later.", 429);
  await recordHit(db, key);
  const password = typeof b.password === "string" ? b.password : "";
  if (password.length < 8) return fail("Your password needs at least 8 characters.");
  if (password.length > 200) return fail("That password is too long.");
  const userId = await takeToken(db, str(b.token, 100), "reset");
  if (!userId) return fail("This link has expired or was already used. Please ask for a new one.", 410);
  const u = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first<UserRow>();
  if (!u) return fail("This link has expired or was already used. Please ask for a new one.", 410);
  const hash = await hashPassword(password);
  await db.batch([
    // Using the emailed link also proves the address is theirs.
    db.prepare("UPDATE users SET password_hash = ?1, email_verified = 1 WHERE id = ?2").bind(hash, u.id),
    db.prepare("DELETE FROM email_tokens WHERE user_id = ?1").bind(u.id),
  ]);
  await clearHits(db, `login:email:${u.email}`);
  c.wait(sendEmail(c.env, passwordChangedEmail(c.env.APP_NAME, u.email, u.name)));
  return json({ ok: true }, 200, { "Set-Cookie": setSession(c.url, await makeSession(c.env.SESSION_SECRET, u.id, hash), SESSION_S) });
}

async function deleteAccount(c: Ctx, u: UserRow): Promise<Response> {
  const b = await body(c.req);
  const key = `delete:${u.id}`;
  if (await isLimited(c.env.DB, key, 5, 3600_000)) return fail("Too many attempts. Please try again later.", 429);
  if (!(await verifyPassword(typeof b.password === "string" ? b.password : "", u.password_hash))) {
    await recordHit(c.env.DB, key);
    return fail("Incorrect password.", 401);
  }
  if (u.stripe_sub_id && c.env.STRIPE_SECRET_KEY && ["active", "trialing", "past_due"].includes(u.sub_status)) {
    return fail("Please cancel your subscription first (Manage billing), then delete your account.", 409);
  }
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM invites WHERE meeting_id IN (SELECT id FROM meetings WHERE owner_id = ?1)").bind(u.id),
    db.prepare("DELETE FROM meetings WHERE owner_id = ?1").bind(u.id),
    db.prepare("DELETE FROM meeting_refs WHERE owner_id = ?1").bind(u.id),
    db.prepare("DELETE FROM api_keys WHERE user_id = ?1").bind(u.id),
    db.prepare("DELETE FROM email_tokens WHERE user_id = ?1").bind(u.id),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(u.id),
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": setSession(c.url, "", 0) });
}

/* ---------- billing (Stripe subscription) ---------- */

async function syncSubscription(env: Env, userId: number, sub: StripeSubscription): Promise<void> {
  const u = await env.DB.prepare("SELECT stripe_sub_id FROM users WHERE id = ?1").bind(userId).first<{ stripe_sub_id: string | null }>();
  if (!u) return;
  // A late event about an old, ended subscription must not undo a newer one.
  if (u.stripe_sub_id && u.stripe_sub_id !== sub.id && ["canceled", "incomplete_expired"].includes(sub.status)) return;
  await env.DB
    .prepare(
      "UPDATE users SET stripe_customer_id = ?1, stripe_sub_id = ?2, sub_status = ?3, sub_period_end = ?4, sub_cancel_at_end = ?5 WHERE id = ?6"
    )
    .bind(sub.customer, sub.id, sub.status, periodEndMs(sub), sub.cancel_at_period_end ? 1 : 0, userId)
    .run();
}

async function checkout(c: Ctx, u: UserRow): Promise<Response> {
  if (!c.env.STRIPE_SECRET_KEY) return fail("Payments aren't set up yet. Please contact the site owner.", 503);
  if (isSubscribed(c.env, u) && c.env.DEV_SKIP_BILLING !== "1") return fail("Your host account is already active.");
  try {
    const s = await createSubscriptionCheckout(c.env, {
      origin: origin(c),
      userId: u.id,
      email: u.email,
      customerId: u.stripe_customer_id,
      appName: c.env.APP_NAME,
    });
    return s.url ? json({ url: s.url }) : fail("Couldn't start checkout. Please try again.", 502);
  } catch (err) {
    console.error("Stripe checkout failed:", err);
    return fail("Couldn't start checkout. Please try again.", 502);
  }
}

async function confirmCheckout(c: Ctx, u: UserRow): Promise<Response> {
  if (!c.env.STRIPE_SECRET_KEY) return fail("Payments aren't set up yet.", 503);
  const b = await body(c.req);
  const id = str(b.sessionId, 200);
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return fail("That checkout isn't valid.");
  try {
    const s = await retrieveCheckout(c.env, id);
    if (s.client_reference_id !== String(u.id) || s.mode !== "subscription") return fail("That checkout isn't yours.", 403);
    if (s.status !== "complete" || !s.subscription) return json({ user: publicUser(c.env, u), pending: true });
    await syncSubscription(c.env, u.id, await retrieveSubscription(c.env, s.subscription));
    const fresh = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(u.id).first<UserRow>();
    return json({ user: publicUser(c.env, fresh!) });
  } catch (err) {
    console.error("Checkout confirm failed:", err);
    return fail("We couldn't confirm your payment yet. It may take a moment: reload in a minute.", 502);
  }
}

async function portal(c: Ctx, u: UserRow): Promise<Response> {
  if (!c.env.STRIPE_SECRET_KEY || !u.stripe_customer_id) return fail("There's no billing account to manage yet.", 400);
  try {
    return json({ url: await createPortalSession(c.env, u.stripe_customer_id, `${origin(c)}/dashboard`) });
  } catch (err) {
    console.error("Stripe portal failed:", err);
    return fail("Couldn't open the billing page. Please try again.", 502);
  }
}

async function stripeWebhook(c: Ctx): Promise<Response> {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });
  const raw = await c.req.text();
  const event = await verifyWebhook(raw, c.req.headers.get("Stripe-Signature"), c.env.STRIPE_WEBHOOK_SECRET);
  if (!event) return new Response("Bad signature", { status: 400 });

  const db = c.env.DB;
  const seen = await db.prepare("INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?1, ?2)").bind(event.id, Date.now()).run();
  if (!seen.meta.changes) return new Response("ok"); // already handled

  try {
    const obj = event.data.object as Record<string, unknown>;
    if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
      const userId = Number(obj.client_reference_id);
      if (Number.isInteger(userId) && typeof obj.subscription === "string" && c.env.STRIPE_SECRET_KEY) {
        await syncSubscription(c.env, userId, await retrieveSubscription(c.env, obj.subscription));
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      let sub = obj as unknown as StripeSubscription;
      // Stripe doesn't promise events arrive in order, so read the subscription as it is right now.
      if (c.env.STRIPE_SECRET_KEY && typeof sub.id === "string") sub = await retrieveSubscription(c.env, sub.id);
      let userId = Number(sub.metadata?.user_id);
      if (!Number.isInteger(userId) || userId <= 0) {
        const r = await db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?1").bind(sub.customer).first<{ id: number }>();
        userId = r?.id ?? 0;
      }
      if (userId) await syncSubscription(c.env, userId, sub);
    }
  } catch (err) {
    console.error("Webhook handling failed:", err);
    await db.prepare("DELETE FROM stripe_events WHERE id = ?1").bind(event.id).run(); // let Stripe retry
    return new Response("Error", { status: 500 });
  }
  return new Response("ok");
}

/* ---------- meetings ---------- */

export type MeetingRow = { id: string; owner_id: number; title: string; starts_at: number; duration_min: number; tz: string; kind: "scheduled" | "instant"; created_at: number };

export const meetingUrl = (c: Ctx, id: string) => `${origin(c)}/m/${id}`;

export async function sendInvites(
  c: Ctx,
  host: UserRow,
  m: Pick<MeetingRow, "id" | "title" | "starts_at" | "duration_min" | "tz">,
  emails: string[],
  note: string
): Promise<number> {
  let sent = 0;
  for (const email of emails) {
    const r = await c.env.DB
      .prepare("INSERT OR IGNORE INTO invites (meeting_id, email, sent_at) VALUES (?1, ?2, ?3)")
      .bind(m.id, email, Date.now())
      .run();
    if (!r.meta.changes) continue; // already invited
    sent++;
    await recordHit(c.env.DB, `invite:${host.id}`);
    c.wait(
      sendEmail(
        c.env,
        inviteEmail(c.env.APP_NAME, email, { name: host.name, email: host.email }, {
          title: m.title,
          when: formatWhen(m.starts_at, m.tz),
          durationMin: m.duration_min,
          link: meetingUrl(c, m.id),
          note,
        })
      )
    );
  }
  return sent;
}

/** Checks the host may send this many invitations right now. Returns an error response or null. */
export async function checkInviteAllowed(c: Ctx, u: UserRow, count: number): Promise<Response | null> {
  if (count === 0) return null;
  if (!u.email_verified) return fail("Please confirm your email address first (check your inbox), then you can send invitations.", 403, { code: "verify_email" });
  const row = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?1 AND ts >= ?2")
    .bind(`invite:${u.id}`, Date.now() - 24 * 3600_000)
    .first<{ n: number }>();
  if ((row?.n ?? 0) + count > 30) return fail("You've reached today's limit of 30 invitations. Please try again tomorrow.", 429);
  return null;
}

const subscriptionRequired = (c: Ctx) =>
  fail(`Hosting meetings needs a host account (${priceLabel(c.env)}). Subscribe from your dashboard to continue.`, 402, { code: "subscription_required" });

async function listMeetings(c: Ctx, u: UserRow): Promise<Response> {
  const db = c.env.DB;
  const [ms, inv] = await Promise.all([
    db.prepare("SELECT * FROM meetings WHERE owner_id = ?1 AND kind = 'scheduled' ORDER BY starts_at").bind(u.id).all<MeetingRow>(),
    db
      .prepare("SELECT i.meeting_id, i.email FROM invites i JOIN meetings m ON m.id = i.meeting_id WHERE m.owner_id = ?1 ORDER BY i.id")
      .bind(u.id)
      .all<{ meeting_id: string; email: string }>(),
  ]);
  const invited = new Map<string, string[]>();
  for (const r of inv.results) invited.set(r.meeting_id, [...(invited.get(r.meeting_id) ?? []), r.email]);
  const now = Date.now();
  const shape = (m: MeetingRow) => ({
    id: m.id,
    title: m.title,
    startsAt: m.starts_at,
    durationMin: m.duration_min,
    tz: m.tz,
    url: meetingUrl(c, m.id),
    invited: invited.get(m.id) ?? [],
  });
  const over = (m: MeetingRow) => windowState(m.starts_at, m.duration_min, now) === "over";
  return json({
    upcoming: ms.results.filter((m) => !over(m)).map(shape),
    past: ms.results.filter(over).reverse().slice(0, 20).map(shape),
  });
}

async function createMeeting(c: Ctx, u: UserRow): Promise<Response> {
  if (!isSubscribed(c.env, u)) return subscriptionRequired(c);
  const b = await body(c.req);
  const now = Date.now();
  const instant = b.instant === true;
  const title = str(b.title, 100) || (instant ? "Instant meeting" : "Meeting");
  const note = str(b.note, 500);
  const tz = str(b.tz, 60);
  const startsAt = instant ? now : Number(b.startsAt);
  const durationMin = instant ? 1440 : Math.round(Number(b.durationMin));
  if (!instant) {
    if (!Number.isFinite(startsAt) || startsAt < now - 10 * 60_000 || startsAt > now + 365 * 86400_000) return fail("Please pick a date and time in the next year.");
    if (!Number.isFinite(durationMin) || durationMin < 15 || durationMin > 480) return fail("Please choose a length between 15 minutes and 8 hours.");
    if (!validTz(tz)) return fail("We couldn't read your time zone. Please reload the page.");
  }
  const emails = parseEmails(b.invitees).filter((e) => e !== u.email);
  if (emails.some((e) => !EMAIL_RE.test(e))) return fail(`"${emails.find((e) => !EMAIL_RE.test(e))}" isn't a valid email address.`);
  if (emails.length > 10) return fail("You can invite up to 10 people at a time.");
  const denied = await checkInviteAllowed(c, u, emails.length);
  if (denied) return denied;

  const id = randomId(12);
  if (instant) await c.env.DB.prepare("DELETE FROM meetings WHERE kind = 'instant' AND starts_at < ?1").bind(now - 3 * 86400_000).run();
  await c.env.DB
    .prepare("INSERT INTO meetings (id, owner_id, title, starts_at, duration_min, tz, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, u.id, title, startsAt, durationMin, validTz(tz) ? tz : "UTC", instant ? "instant" : "scheduled", now)
    .run();
  const invited = await sendInvites(c, u, { id, title, starts_at: startsAt, duration_min: durationMin, tz: validTz(tz) ? tz : "UTC" }, emails, note);
  return json({ id, url: meetingUrl(c, id), invited });
}

async function inviteMore(c: Ctx, u: UserRow, id: string): Promise<Response> {
  if (!isSubscribed(c.env, u)) return subscriptionRequired(c);
  const m = await c.env.DB.prepare("SELECT * FROM meetings WHERE id = ?1 AND owner_id = ?2").bind(id, u.id).first<MeetingRow>();
  if (!m) return fail("Meeting not found.", 404);
  const b = await body(c.req);
  const emails = parseEmails(b.invitees).filter((e) => e !== u.email);
  if (!emails.length) return fail("Please enter at least one email address.");
  if (emails.some((e) => !EMAIL_RE.test(e))) return fail(`"${emails.find((e) => !EMAIL_RE.test(e))}" isn't a valid email address.`);
  if (emails.length > 10) return fail("You can invite up to 10 people at a time.");
  const denied = await checkInviteAllowed(c, u, emails.length);
  if (denied) return denied;
  const sent = await sendInvites(c, u, m, emails, str(b.note, 500));
  return json({ ok: true, invited: sent });
}

async function deleteMeeting(c: Ctx, u: UserRow, id: string): Promise<Response> {
  const owned = await c.env.DB.prepare("SELECT 1 FROM meetings WHERE id = ?1 AND owner_id = ?2").bind(id, u.id).first();
  if (!owned) return fail("Meeting not found.", 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM invites WHERE meeting_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM meeting_refs WHERE meeting_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM meetings WHERE id = ?1").bind(id),
  ]);
  return json({ ok: true });
}

/** Gives the host a new personal room link. The old one stops working straight away (use if it was shared too widely). */
async function rotatePersonalRoom(c: Ctx, u: UserRow): Promise<Response> {
  const key = `rotate:${u.id}`;
  if (await isLimited(c.env.DB, key, 10, 24 * 3600_000)) return fail("You've changed your link a lot today. Please try again tomorrow.", 429);
  await recordHit(c.env.DB, key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomId(12);
    try {
      await c.env.DB.prepare("UPDATE users SET personal_room = ?1 WHERE id = ?2").bind(id, u.id).run();
      return json({ personalRoom: id, url: meetingUrl(c, id) });
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err;
    }
  }
  return fail("Sorry, that didn't work. Please try again.", 500);
}

/* ---------- joining a meeting ---------- */

type Room = { title: string; hostName: string; ownerId: number; owner: Pick<UserRow, "sub_status">; personal: boolean; startsAt: number | null; durationMin: number | null };

async function findRoom(env: Env, id: string): Promise<Room | null> {
  if (!/^[a-z2-9]{12}$/.test(id)) return null;
  const m = await env.DB
    .prepare("SELECT m.*, u.name AS host_name, u.sub_status FROM meetings m JOIN users u ON u.id = m.owner_id WHERE m.id = ?1")
    .bind(id)
    .first<MeetingRow & { host_name: string; sub_status: string }>();
  if (m) {
    return { title: m.title, hostName: m.host_name, ownerId: m.owner_id, owner: { sub_status: m.sub_status }, personal: false, startsAt: m.starts_at, durationMin: m.duration_min };
  }
  const u = await env.DB.prepare("SELECT id, name, sub_status FROM users WHERE personal_room = ?1").bind(id).first<{ id: number; name: string; sub_status: string }>();
  if (u) {
    return { title: `${u.name}'s room`, hostName: u.name, ownerId: u.id, owner: { sub_status: u.sub_status }, personal: true, startsAt: null, durationMin: null };
  }
  return null;
}

function roomStatus(env: Env, r: Room, isHost: boolean): "open" | "early" | "over" | "unavailable" {
  if (!isSubscribed(env, r.owner)) return "unavailable";
  if (r.personal || isHost) return "open";
  return windowState(r.startsAt!, r.durationMin!);
}

/** A personal join link (made through the API) for this meeting, if one came with the request and is valid. */
async function linkFor(c: Ctx, id: string, token: unknown) {
  return token ? verifyInvite(c.env.SESSION_SECRET, token, id) : null;
}

async function roomInfo(c: Ctx, id: string): Promise<Response> {
  const r = await findRoom(c.env, id);
  if (!r) return fail("This meeting link isn't valid. Check you copied all of it.", 404);
  const me = await getUser(c);
  const link = await linkFor(c, id, c.url.searchParams.get("link"));
  const isHost = (!!me && me.id === r.ownerId) || link?.role === "host";
  return json({
    title: r.title,
    hostName: r.hostName,
    personal: r.personal,
    startsAt: r.startsAt,
    status: roomStatus(c.env, r, isHost),
    isHost,
    userName: link?.name ?? me?.name ?? "",
    nameFixed: !!link,
    maxPeople: rtkConfigured(c.env) ? rtkMax(c.env) : 4,
    appName: c.env.APP_NAME,
  });
}

async function joinRoom(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const id = str(b.room, 20);
  const r = await findRoom(c.env, id);
  if (!r) return fail("This meeting link isn't valid. Check you copied all of it.", 404);
  const me = await getUser(c);
  const link = await linkFor(c, id, b.link);
  const isHost = (!!me && me.id === r.ownerId) || link?.role === "host";
  const status = roomStatus(c.env, r, isHost);
  if (status === "unavailable") return fail("This meeting isn't available right now. The host's account is inactive.", 403);
  if (status === "early") return fail("This meeting hasn't opened yet. It opens 15 minutes before the start time.", 403);
  if (status === "over") return fail("This meeting has finished.", 410);

  // The browser keeps a secret key per meeting; its id in the room is derived from it, so nobody else can claim that id.
  const deviceKey = typeof b.key === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(b.key) ? b.key : randomToken();
  const pid = await participantId(c.env.SESSION_SECRET, id, deviceKey);
  // A personal join link fixes the name (e.g. the tutor's or student's name from the booking site).
  const name = link?.name || str(b.name, 40).replace(/[<>]/g, "").replace(/\(host\)/gi, "").trim() || me?.name || "Guest";
  const lifetimeMs = 6 * 3600_000;
  const ice = await getIce(c.env, lifetimeMs / 1000);
  if (!ice) return fail("Video isn't switched on yet: the Cloudflare TURN key is missing or isn't working.", 503);
  const token = await signJoin(c.env.SESSION_SECRET, { room: id, pid, name, host: isHost, exp: Date.now() + lifetimeMs });
  return json({ token, pid, key: deviceKey, isHost, largeCalls: rtkConfigured(c.env) ? rtkMax(c.env) : 0, iceServers: ice.iceServers, relayOnly: ice.relayOnly, appName: c.env.APP_NAME });
}

/**
 * A RealtimeKit token, for a meeting that has grown past 4 people and switched over. The room's Durable Object
 * decides: it only gives one to someone who is connected to this meeting right now, once the meeting has switched.
 */
async function joinRtk(c: Ctx): Promise<Response> {
  const b = await body(c.req);
  const key = `rtk:ip:${ip(c.req)}`;
  if (await isLimited(c.env.DB, key, 60, 3600_000)) return fail("Too many attempts. Please try again later.", 429);
  await recordHit(c.env.DB, key);
  const id = str(b.room, 20);
  const r = await findRoom(c.env, id);
  if (!r) return fail("This meeting link isn't valid. Check you copied all of it.", 404);
  const me = await getUser(c);
  const link = await linkFor(c, id, b.link);
  const isHost = (!!me && me.id === r.ownerId) || link?.role === "host";
  const status = roomStatus(c.env, r, isHost);
  if (status !== "open") return fail("This meeting isn't open right now.", 403);
  if (typeof b.key !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(b.key)) return fail("Please rejoin the meeting.", 400);
  const pid = await participantId(c.env.SESSION_SECRET, id, b.key);
  const name = link?.name || str(b.name, 40).replace(/[<>]/g, "").replace(/\(host\)/gi, "").trim() || me?.name || "Guest";
  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(id));
  const res = await stub.fetch("https://room/rtk-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid, name, host: isHost, title: r.title }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (res.ok && data.token) return json({ token: data.token });
  if (data.error === "not_upgraded") return fail("This meeting is still a small call.", 409, { code: "not_upgraded" });
  if (data.error === "not_in_room") return fail("Please rejoin the meeting.", 403);
  return fail("We couldn't move the meeting to the larger-call service. Please try again in a moment.", 502);
}

/* ---------- API keys (made on the dashboard, used by other services) ---------- */

type ApiKeyRow = { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null };

async function listKeys(c: Ctx, u: UserRow): Promise<Response> {
  const r = await c.env.DB.prepare("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ?1 ORDER BY id").bind(u.id).all<ApiKeyRow>();
  return json({ keys: r.results.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })) });
}

async function createKey(c: Ctx, u: UserRow): Promise<Response> {
  const b = await body(c.req);
  const name = str(b.name, 60) || "API key";
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?1").bind(u.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 10) return fail("You can have up to 10 API keys. Delete one you don't use first.");
  // Shown once. Only its hash is stored, like a password.
  const key = `mk_${randomToken()}`;
  await c.env.DB
    .prepare("INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(u.id, name, await sha256Hex(key), key.slice(0, 10), Date.now())
    .run();
  return json({ key, name });
}

async function deleteKey(c: Ctx, u: UserRow, id: number): Promise<Response> {
  const r = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?1 AND user_id = ?2").bind(id, u.id).run();
  return r.meta.changes ? json({ ok: true }) : fail("Key not found.", 404);
}

/* ---------- router ---------- */

/** True when the Origin header is missing or is this site. A malformed Origin (e.g. "null") is never trusted. */
export function sameOrigin(req: Request, url: URL): boolean {
  if (req.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = req.headers.get("Origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

/** Browser API calls always send JSON. Requiring it means a plain cross-site form can't post to the API. */
const isJson = (req: Request) => (req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";

export async function handleApi(req: Request, env: Env, url: URL, wait: (p: Promise<unknown>) => void): Promise<Response> {
  const c: Ctx = { req, env, url, wait };
  const path = url.pathname;
  const post = req.method === "POST";

  if (path === "/api/stripe/webhook" && post) return stripeWebhook(c); // signed by Stripe, not a browser
  if (path.startsWith("/api/v1/")) return handleV1(c); // for other services: API key, not a browser session
  if (post && (!sameOrigin(req, url) || !isJson(req))) return fail("Forbidden", 403);
  if (!env.SESSION_SECRET) return fail("Not set up yet: the SESSION_SECRET secret is missing.", 503);

  // public
  if (path === "/api/signup" && post) return signup(c);
  if (path === "/api/login" && post) return login(c);
  if (path === "/api/logout" && post) return json({ ok: true }, 200, { "Set-Cookie": setSession(url, "", 0) });
  if (path === "/api/forgot" && post) return forgot(c);
  if (path === "/api/reset" && post) return resetPassword(c);
  if (path === "/api/verify" && post) return verify(c);
  if (path === "/api/join" && post) return joinRoom(c);
  if (path === "/api/join/rtk" && post) return joinRtk(c);
  const room = /^\/api\/room\/([a-z2-9]{12})$/.exec(path);
  if (room && req.method === "GET") return roomInfo(c, room[1]);

  // signed-in
  const u = await getUser(c);
  if (path === "/api/me" && req.method === "GET") {
    return json({ user: u ? publicUser(env, u) : null, appName: env.APP_NAME, price: priceLabel(env) });
  }
  if (!u) return fail("Please log in first.", 401);

  if (path === "/api/verify/resend" && post) return resendVerify(c, u);
  if (path === "/api/account/delete" && post) return deleteAccount(c, u);
  if (path === "/api/billing/checkout" && post) return checkout(c, u);
  if (path === "/api/billing/confirm" && post) return confirmCheckout(c, u);
  if (path === "/api/billing/portal" && post) return portal(c, u);
  if (path === "/api/personal-room/rotate" && post) return rotatePersonalRoom(c, u);
  if (path === "/api/keys" && req.method === "GET") return listKeys(c, u);
  if (path === "/api/keys" && post) return createKey(c, u);
  const delKey = /^\/api\/keys\/(\d{1,9})\/delete$/.exec(path);
  if (delKey && post) return deleteKey(c, u, Number(delKey[1]));
  if (path === "/api/meetings" && req.method === "GET") return listMeetings(c, u);
  if (path === "/api/meetings" && post) return createMeeting(c, u);
  const inv = /^\/api\/meetings\/([a-z2-9]{12})\/invite$/.exec(path);
  if (inv && post) return inviteMore(c, u, inv[1]);
  const del = /^\/api\/meetings\/([a-z2-9]{12})\/delete$/.exec(path);
  if (del && post) return deleteMeeting(c, u, del[1]);

  return fail("Not found", 404);
}
