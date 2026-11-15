// Business teams. The owner pays per seat (their own seat included), invites people by email, and each member
// gets the Business plan while they're in the team. Large-call minutes are pooled across the team.

import type { Ctx, UserRow } from "./api";
import { body, devSetPlan, EMAIL_RE, ip, isSubscribed, json, MAX_SEATS, origin, planRequired, str } from "./api";
import { randomToken, sha256Hex } from "./crypto";
import { sendEmail, teamInviteEmail } from "./email";
import { isLimited, recordHit } from "./ratelimit";
import { retrieveSubscription, seatsOf, setSeats } from "./stripe";

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const INVITE_MS = 14 * 86400_000;

/** True for someone who pays for a Business (or Enterprise) plan themselves, so can have a team. */
const ownsTeam = (u: UserRow) => u.acct.ownPlan === "business" || u.acct.ownPlan === "enterprise";

async function members(c: Ctx, ownerId: number) {
  const r = await c.env.DB
    .prepare("SELECT u.id, u.name, u.email FROM team_members t JOIN users u ON u.id = t.user_id WHERE t.owner_id = ?1 ORDER BY t.joined_at")
    .bind(ownerId)
    .all<{ id: number; name: string; email: string }>();
  return r.results;
}
async function invites(c: Ctx, ownerId: number) {
  const r = await c.env.DB.prepare("SELECT email FROM team_invites WHERE owner_id = ?1 AND expires_at > ?2 ORDER BY email").bind(ownerId, Date.now()).all<{ email: string }>();
  return r.results.map((x) => x.email);
}

async function view(c: Ctx, u: UserRow): Promise<Response> {
  let memberOf: { name: string; email: string } | null = null;
  if (u.acct.teamOwnerId) memberOf = await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?1").bind(u.acct.teamOwnerId).first<{ name: string; email: string }>();
  if (!ownsTeam(u)) return json({ owner: false, memberOf, memberActive: u.acct.billingId !== u.id });
  const [m, i] = await Promise.all([members(c, u.id), invites(c, u.id)]);
  return json({ owner: true, memberOf, seats: u.acct.ownSeats, used: 1 + m.length + i.length, members: m, invites: i });
}

async function invite(c: Ctx, u: UserRow): Promise<Response> {
  if (!ownsTeam(u)) return planRequired("business", "A team");
  const email = str((await body(c.req)).email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("Please enter a valid email address.");
  if (email === u.email) return fail("That's you. You already have a seat.");
  const key = `teaminvite:${u.id}`;
  if (await isLimited(c.env.DB, key, 50, 24 * 3600_000)) return fail("You've sent a lot of invitations today. Please try again tomorrow.", 429);
  const [m, i] = await Promise.all([members(c, u.id), invites(c, u.id)]);
  if (m.some((x) => x.email === email)) return fail("They're already in your team.");
  if (!i.includes(email) && 1 + m.length + i.length >= u.acct.ownSeats) {
    return fail(`All ${u.acct.ownSeats} of your seats are in use. Add a seat first.`, 409, { code: "no_seats" });
  }
  await recordHit(c.env.DB, key);
  const token = randomToken();
  await c.env.DB
    .prepare("INSERT INTO team_invites (token_hash, owner_id, email, expires_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner_id, email) DO UPDATE SET token_hash = ?1, expires_at = ?4")
    .bind(await sha256Hex(token), u.id, email, Date.now() + INVITE_MS)
    .run();
  c.wait(sendEmail(c.env, teamInviteEmail(c.env.APP_NAME, email, { name: u.name, email: u.email }, `${origin(c)}/team?token=${token}`)));
  return view(c, u);
}

/** What an invitation is, for the page that accepts it (before the person has logged in). */
async function peek(c: Ctx): Promise<Response> {
  const key = `teampeek:${ip(c.req)}`;
  if (await isLimited(c.env.DB, key, 30, 3600_000)) return fail("Too many attempts. Please try again later.", 429);
  await recordHit(c.env.DB, key);
  const token = str((await body(c.req)).token, 100);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return fail("This invitation isn't valid.", 404);
  const r = await c.env.DB
    .prepare("SELECT u.name, i.email FROM team_invites i JOIN users u ON u.id = i.owner_id WHERE i.token_hash = ?1 AND i.expires_at > ?2")
    .bind(await sha256Hex(token), Date.now())
    .first<{ name: string; email: string }>();
  return r ? json({ ownerName: r.name, email: r.email }) : fail("This invitation has expired or was already used. Ask for a new one.", 404);
}

async function accept(c: Ctx, u: UserRow): Promise<Response> {
  const token = str((await body(c.req)).token, 100);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return fail("This invitation isn't valid.", 404);
  if (ownsTeam(u)) return fail("You already pay for a Business plan of your own. Cancel it first if you'd rather join this team.", 409);
  if (u.acct.teamOwnerId) return fail("You're already in a team. Leave it first to join another.", 409);
  // Using the invitation and removing it happen together, so it can only ever be used once.
  const inv = await c.env.DB
    .prepare("DELETE FROM team_invites WHERE token_hash = ?1 AND expires_at > ?2 RETURNING owner_id")
    .bind(await sha256Hex(token), Date.now())
    .first<{ owner_id: number }>();
  if (!inv) return fail("This invitation has expired or was already used. Ask for a new one.", 404);
  if (inv.owner_id === u.id) return fail("That's your own team.");
  await c.env.DB.prepare("INSERT OR IGNORE INTO team_members (user_id, owner_id, joined_at) VALUES (?1, ?2, ?3)").bind(u.id, inv.owner_id, Date.now()).run();
  return json({ ok: true });
}

async function remove(c: Ctx, u: UserRow): Promise<Response> {
  if (!ownsTeam(u)) return planRequired("business", "A team");
  const b = await body(c.req);
  if (typeof b.userId === "number") await c.env.DB.prepare("DELETE FROM team_members WHERE user_id = ?1 AND owner_id = ?2").bind(b.userId, u.id).run();
  const email = str(b.email, 254).toLowerCase();
  if (email) await c.env.DB.prepare("DELETE FROM team_invites WHERE owner_id = ?1 AND email = ?2").bind(u.id, email).run();
  return view(c, u);
}

async function leave(c: Ctx, u: UserRow): Promise<Response> {
  await c.env.DB.prepare("DELETE FROM team_members WHERE user_id = ?1").bind(u.id).run();
  return json({ ok: true });
}

async function seats(c: Ctx, u: UserRow): Promise<Response> {
  if (u.acct.ownPlan !== "business") return planRequired("business", "A team");
  const n = Math.round(Number((await body(c.req)).seats));
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) return fail(`Please choose between 1 and ${MAX_SEATS} users.`);
  const [m, i] = await Promise.all([members(c, u.id), invites(c, u.id)]);
  const used = 1 + m.length + i.length;
  if (n < used) return fail(`${used} seats are in use (you, your members and pending invitations). Remove someone first.`, 409);
  if (c.env.DEV_SKIP_BILLING === "1") {
    await devSetPlan(c.env, u.id, "business", n);
  } else {
    if (!c.env.STRIPE_SECRET_KEY || !u.stripe_sub_id || !isSubscribed(c.env, u)) return fail("There's no active subscription to change.", 400);
    try {
      const sub = await setSeats(c.env, u.stripe_sub_id, n);
      await c.env.DB.prepare("UPDATE account_plan SET seats = ?1 WHERE user_id = ?2").bind(seatsOf(sub.items ? sub : await retrieveSubscription(c.env, u.stripe_sub_id)), u.id).run();
    } catch (err) {
      console.error("Changing seats failed:", err);
      return fail("Couldn't change your seats. Please try again.", 502);
    }
  }
  const [m2, i2] = await Promise.all([members(c, u.id), invites(c, u.id)]);
  return json({ owner: true, memberOf: null, seats: n, used: 1 + m2.length + i2.length, members: m2, invites: i2 });
}

/** Public: looking at an invitation before logging in. */
export async function handleTeamPublic(c: Ctx, path: string, method: string): Promise<Response | null> {
  if (path === "/api/team/peek" && method === "POST") return peek(c);
  return null;
}

export async function handleTeam(c: Ctx, u: UserRow, path: string, method: string): Promise<Response | null> {
  if (!path.startsWith("/api/team")) return null;
  if (path === "/api/team" && method === "GET") return view(c, u);
  if (method !== "POST") return null;
  if (path === "/api/team/invite") return invite(c, u);
  if (path === "/api/team/accept") return accept(c, u);
  if (path === "/api/team/remove") return remove(c, u);
  if (path === "/api/team/leave") return leave(c, u);
  if (path === "/api/team/seats") return seats(c, u);
  return null;
}
