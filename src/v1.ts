// The API other services use (e.g. a tutoring or booking site), version 1. See API.md.
//
// Auth: "Authorization: Bearer mk_..." with a key made on the dashboard. The whole API needs the key's account to
// have an active host subscription. Meetings made through the API belong to that account and follow the same rules
// as the dashboard (email invitations need a confirmed email and count towards the daily limit). Server-to-server only: never put a key in
// browser code.

import {
  EMAIL_RE,
  ownerEmbedOrigins,
  body,
  checkInviteAllowed,
  isSubscribed,
  json,
  meetingUrl,
  parseEmails,
  priceLabel,
  sendInvites,
  str,
  validTz,
  windowState,
  type Ctx,
  type MeetingRow,
  type UserRow,
} from "./api";
import { randomId, sha256Hex, signInvite } from "./crypto";
import { isLimited, recordHit } from "./ratelimit";

type Key = { keyId: number; lastUsed: number | null; user: UserRow };

const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message } }, status, headers);

const EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const iso = (ms: number) => new Date(ms).toISOString();

async function authenticate(c: Ctx): Promise<Key | Response> {
  const m = /^Bearer\s+(mk_[A-Za-z0-9_-]{20,80})$/.exec(c.req.headers.get("Authorization") ?? "");
  if (!m) return err(401, "unauthorized", "Send your API key as: Authorization: Bearer mk_...", { "WWW-Authenticate": "Bearer" });
  const row = await c.env.DB
    .prepare("SELECT k.id AS key_id, k.last_used_at, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?1")
    .bind(await sha256Hex(m[1]))
    .first<UserRow & { key_id: number; last_used_at: number | null }>();
  if (!row) return err(401, "unauthorized", "That API key isn't valid. It may have been deleted.", { "WWW-Authenticate": "Bearer" });
  const { key_id, last_used_at, ...user } = row;
  return { keyId: key_id, lastUsed: last_used_at, user: user as UserRow };
}

function shape(c: Ctx, m: MeetingRow, externalId: string | null) {
  const state = windowState(m.starts_at, m.duration_min);
  return {
    id: m.id,
    url: meetingUrl(c, m.id),
    title: m.title,
    startsAt: iso(m.starts_at),
    durationMin: m.duration_min,
    timezone: m.tz,
    externalId,
    status: state === "early" ? "upcoming" : state === "open" ? "open" : "ended",
    createdAt: iso(m.created_at),
  };
}

/** Accepts an ISO 8601 date-time string (e.g. "2026-11-20T16:00:00Z") or epoch milliseconds. */
function parseTime(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return NaN;
}

function checkTimes(startsAt: number, durationMin: number): Response | null {
  const now = Date.now();
  if (!Number.isFinite(startsAt)) return err(400, "invalid_starts_at", 'startsAt must be an ISO 8601 date-time such as "2026-11-20T16:00:00Z", or epoch milliseconds.');
  if (startsAt < now - 10 * 60_000 || startsAt > now + 365 * 86400_000) return err(400, "invalid_starts_at", "startsAt must be in the next year.");
  if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 480) return err(400, "invalid_duration", "durationMin must be a whole number from 15 to 480.");
  return null;
}

async function getOwned(c: Ctx, k: Key, id: string): Promise<{ m: MeetingRow; externalId: string | null } | null> {
  if (!/^[a-z2-9]{12}$/.test(id)) return null;
  const m = await c.env.DB.prepare("SELECT * FROM meetings WHERE id = ?1 AND owner_id = ?2").bind(id, k.user.id).first<MeetingRow>();
  if (!m) return null;
  const ref = await c.env.DB.prepare("SELECT external_id FROM meeting_refs WHERE meeting_id = ?1").bind(id).first<{ external_id: string }>();
  return { m, externalId: ref?.external_id ?? null };
}

const notFound = () => err(404, "not_found", "No meeting with that id on this account.");
const needsSubscription = (c: Ctx) =>
  err(402, "subscription_required", `This account needs an active host subscription (${priceLabel(c.env)}) to host meetings.`);

/* ---------- endpoints ---------- */

async function account(c: Ctx, k: Key): Promise<Response> {
  return json({ data: { name: k.user.name, email: k.user.email, subscribed: isSubscribed(c.env, k.user), emailConfirmed: !!k.user.email_verified, embedOrigins: await ownerEmbedOrigins(c.env, k.user.id) } });
}

async function list(c: Ctx, k: Key): Promise<Response> {
  const q = c.url.searchParams;
  const ext = q.get("externalId");
  if (ext !== null) {
    if (!EXTERNAL_ID_RE.test(ext)) return err(400, "invalid_external_id", "externalId may use letters, digits and . _ : - (up to 100).");
    const ref = await c.env.DB.prepare("SELECT meeting_id FROM meeting_refs WHERE owner_id = ?1 AND external_id = ?2").bind(k.user.id, ext).first<{ meeting_id: string }>();
    const found = ref ? await getOwned(c, k, ref.meeting_id) : null;
    return json({ data: found ? [shape(c, found.m, found.externalId)] : [] });
  }
  const from = q.get("from") ? parseTime(q.get("from")) : Date.now() - 86400_000;
  const to = q.get("to") ? parseTime(q.get("to")) : Date.now() + 366 * 86400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return err(400, "invalid_range", "from and to must be ISO 8601 date-times.");
  const limit = Math.min(Math.max(Number.parseInt(q.get("limit") ?? "100", 10) || 100, 1), 200);
  const rows = await c.env.DB
    .prepare(
      `SELECT m.*, r.external_id FROM meetings m LEFT JOIN meeting_refs r ON r.meeting_id = m.id
       WHERE m.owner_id = ?1 AND m.kind = 'scheduled' AND m.starts_at >= ?2 AND m.starts_at <= ?3 ORDER BY m.starts_at LIMIT ?4`
    )
    .bind(k.user.id, from, to, limit)
    .all<MeetingRow & { external_id: string | null }>();
  return json({ data: rows.results.map((m) => shape(c, m, m.external_id)) });
}

async function create(c: Ctx, k: Key): Promise<Response> {
  if (!isSubscribed(c.env, k.user)) return needsSubscription(c);
  const b = await body(c.req);
  const db = c.env.DB;
  const externalId = b.externalId === undefined || b.externalId === null ? null : String(b.externalId);
  if (externalId !== null && !EXTERNAL_ID_RE.test(externalId)) return err(400, "invalid_external_id", "externalId may use letters, digits and . _ : - (up to 100).");

  // Same externalId as before: hand back the meeting already made (safe to retry).
  if (externalId) {
    const ref = await db.prepare("SELECT meeting_id FROM meeting_refs WHERE owner_id = ?1 AND external_id = ?2").bind(k.user.id, externalId).first<{ meeting_id: string }>();
    const found = ref ? await getOwned(c, k, ref.meeting_id) : null;
    if (found) return json({ data: shape(c, found.m, externalId), created: false });
  }

  const title = str(b.title, 100) || "Meeting";
  const startsAt = parseTime(b.startsAt);
  const durationMin = Number(b.durationMin ?? 60);
  const bad = checkTimes(startsAt, durationMin);
  if (bad) return bad;
  const tz = b.timezone === undefined ? "UTC" : str(b.timezone, 60);
  if (!validTz(tz)) return err(400, "invalid_timezone", 'timezone must be an IANA time zone such as "Europe/London".');
  const emails = parseEmails(b.invitees);
  if (emails.some((e) => !EMAIL_RE.test(e))) return err(400, "invalid_invitees", `"${emails.find((e) => !EMAIL_RE.test(e))}" isn't a valid email address.`);
  if (emails.length > 10) return err(400, "invalid_invitees", "Up to 10 invitees at a time.");
  const denied = await checkInviteAllowed(c, k.user, emails.length);
  if (denied) return err(denied.status, denied.status === 429 ? "invite_limit" : "email_not_confirmed", ((await denied.json()) as { error: string }).error);

  const id = randomId(12);
  if (externalId) {
    // Claim the externalId first, so two requests at the same moment can't both make a meeting.
    const claim = await db.prepare("INSERT OR IGNORE INTO meeting_refs (owner_id, external_id, meeting_id) VALUES (?1, ?2, ?3)").bind(k.user.id, externalId, id).run();
    if (!claim.meta.changes) {
      const ref = await db.prepare("SELECT meeting_id FROM meeting_refs WHERE owner_id = ?1 AND external_id = ?2").bind(k.user.id, externalId).first<{ meeting_id: string }>();
      const found = ref ? await getOwned(c, k, ref.meeting_id) : null;
      return found ? json({ data: shape(c, found.m, externalId), created: false }) : err(409, "conflict", "Another request is creating this meeting. Try again in a moment.");
    }
  }
  const m: MeetingRow = { id, owner_id: k.user.id, title, starts_at: startsAt, duration_min: durationMin, tz, kind: "scheduled", created_at: Date.now() };
  try {
    await db
      .prepare("INSERT INTO meetings (id, owner_id, title, starts_at, duration_min, tz, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7)")
      .bind(id, m.owner_id, title, startsAt, durationMin, tz, m.created_at)
      .run();
  } catch (e) {
    if (externalId) await db.prepare("DELETE FROM meeting_refs WHERE owner_id = ?1 AND external_id = ?2").bind(k.user.id, externalId).run();
    throw e;
  }
  const invited = emails.length ? await sendInvites(c, k.user, m, emails, str(b.note, 500)) : 0;
  return json({ data: shape(c, m, externalId), created: true, invited }, 201);
}

async function get(c: Ctx, k: Key, id: string): Promise<Response> {
  const found = await getOwned(c, k, id);
  return found ? json({ data: shape(c, found.m, found.externalId) }) : notFound();
}

async function update(c: Ctx, k: Key, id: string): Promise<Response> {
  if (!isSubscribed(c.env, k.user)) return needsSubscription(c);
  const found = await getOwned(c, k, id);
  if (!found || found.m.kind !== "scheduled") return notFound();
  const b = await body(c.req);
  const m = { ...found.m };
  if (b.title !== undefined) m.title = str(b.title, 100) || m.title;
  if (b.startsAt !== undefined) m.starts_at = parseTime(b.startsAt);
  if (b.durationMin !== undefined) m.duration_min = Number(b.durationMin);
  if (b.timezone !== undefined) {
    m.tz = str(b.timezone, 60);
    if (!validTz(m.tz)) return err(400, "invalid_timezone", 'timezone must be an IANA time zone such as "Europe/London".');
  }
  if (b.startsAt !== undefined || b.durationMin !== undefined) {
    const bad = checkTimes(m.starts_at, m.duration_min);
    if (bad) return bad;
  }
  await c.env.DB
    .prepare("UPDATE meetings SET title = ?1, starts_at = ?2, duration_min = ?3, tz = ?4 WHERE id = ?5 AND owner_id = ?6")
    .bind(m.title, m.starts_at, m.duration_min, m.tz, id, k.user.id)
    .run();
  return json({ data: shape(c, m, found.externalId) });
}

async function remove(c: Ctx, k: Key, id: string): Promise<Response> {
  const found = await getOwned(c, k, id);
  if (!found) return notFound();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM invites WHERE meeting_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM meeting_refs WHERE meeting_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM meetings WHERE id = ?1").bind(id),
  ]);
  return json({ data: { id, deleted: true } });
}

/** A personal join link: opens the meeting with this name, as a host or a guest. No account needed. */
async function link(c: Ctx, k: Key, id: string): Promise<Response> {
  if (!isSubscribed(c.env, k.user)) return needsSubscription(c);
  const found = await getOwned(c, k, id);
  if (!found) return notFound();
  const b = await body(c.req);
  const name = str(b.name, 40).replace(/[<>]/g, "").replace(/\(host\)/gi, "").trim();
  if (!name) return err(400, "invalid_name", "name is required (up to 40 characters). It's shown to everyone in the call.");
  const role = b.role === undefined ? "guest" : b.role;
  if (role !== "host" && role !== "guest") return err(400, "invalid_role", 'role must be "host" or "guest".');
  const days = b.expiresInDays === undefined ? 90 : Number(b.expiresInDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) return err(400, "invalid_expiry", "expiresInDays must be from 1 to 365.");
  const exp = Date.now() + Math.round(days * 86400_000);
  const token = await signInvite(c.env.SESSION_SECRET, { room: id, name, role, exp });
  const url = `${meetingUrl(c, id)}?link=${encodeURIComponent(token)}`;
  const embedUrl = `${url}&embed=1`;
  // Ready to paste into the other site's page. The "allow" list lets the meeting use the camera, mic and screen share.
  const iframe = `<iframe src="${embedUrl.replace(/&/g, "&amp;")}" allow="camera; microphone; display-capture; autoplay; fullscreen" allowfullscreen style="width:100%;height:640px;border:0;border-radius:12px" title="Video meeting"></iframe>`;
  const embedOrigins = await ownerEmbedOrigins(c.env, k.user.id);
  return json({ data: { url, embedUrl, iframe, embedAllowedOn: embedOrigins, name, role, expiresAt: iso(exp) } }, 201);
}

/* ---------- router ---------- */

export async function handleV1(c: Ctx): Promise<Response> {
  const { req, env, url } = c;
  if (!env.SESSION_SECRET) return err(503, "not_configured", "The site isn't set up yet.");
  // Keys belong on servers. A browser on another site calling this means a key has leaked into web page code.
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return err(403, "server_only", "Call this API from your server, never from browser code: it would expose your API key.");
  if ((req.method === "POST" || req.method === "PATCH") && !(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return err(415, "json_required", "Send a JSON body with Content-Type: application/json.");
  }

  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  // The API is part of the paid host account.
  if (!isSubscribed(env, auth.user)) return needsSubscription(c);
  const rl = `api:${auth.keyId}`;
  if (await isLimited(env.DB, rl, 120, 60_000)) return err(429, "rate_limited", "Too many requests. The limit is 120 a minute per key.", { "Retry-After": "60" });
  await recordHit(env.DB, rl);
  if (!auth.lastUsed || auth.lastUsed < Date.now() - 60_000) {
    c.wait(env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").bind(Date.now(), auth.keyId).run());
  }

  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  if (path === "/api/v1/account" && method === "GET") return account(c, auth);
  if (path === "/api/v1/meetings" && method === "GET") return list(c, auth);
  if (path === "/api/v1/meetings" && method === "POST") return create(c, auth);
  const one = /^\/api\/v1\/meetings\/([^/]+)$/.exec(path);
  if (one && method === "GET") return get(c, auth, one[1]);
  if (one && method === "PATCH") return update(c, auth, one[1]);
  if (one && method === "DELETE") return remove(c, auth, one[1]);
  const links = /^\/api\/v1\/meetings\/([^/]+)\/links$/.exec(path);
  if (links && method === "POST") return link(c, auth, links[1]);
  return err(404, "not_found", "No such endpoint. See API.md.");
}
