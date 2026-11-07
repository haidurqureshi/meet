// Pro features: branding (logo, colour, company name), a vanity link (meet.example.com/acme), a waiting room
// (welcome message, agenda, a question for guests) and a page guests are sent to when the host ends the call.

import type { Ctx, UserRow } from "./api";
import { body, isPro, json, origin, str } from "./api";
import type { Env } from "./env";

/** Names that can never be a vanity link: the site's own pages and files, and names people might mistake for us. */
export const RESERVED = new Set([
  // pages and routes
  "index", "signup", "login", "logout", "forgot", "reset", "verify", "legal", "dashboard", "room", "developers",
  "m", "api", "ws", "brand", "vendor", "static", "assets", "favicon",
  // things that would look official
  "admin", "administrator", "root", "system", "www", "mail", "email", "help", "support", "about", "contact",
  "pricing", "pro", "plans", "billing", "account", "accounts", "settings", "security", "privacy", "terms",
  "status", "blog", "docs", "doc", "developer", "app", "apps", "home", "team", "teams", "meet", "meeting",
  "meetings", "join", "invite", "register", "auth", "oauth", "sso", "null", "undefined", "test", "demo",
]);

export const VANITY_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;

export function vanityProblem(name: string): string | null {
  if (!VANITY_RE.test(name) || name.includes("--")) return "Use 3 to 30 lowercase letters, numbers and single dashes, starting and ending with a letter or number.";
  if (RESERVED.has(name)) return "That name is reserved. Please choose another.";
  return null;
}

type SettingsRow = {
  vanity: string | null;
  brand_name: string | null;
  brand_color: string | null;
  logo_version: number;
  welcome: string | null;
  agenda: string | null;
  intake_question: string | null;
  redirect_url: string | null;
};

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

const COLOR_RE = /^#[0-9a-f]{6}$/;

/** Like str(), but keeps line breaks (for the welcome message). */
const multiline = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";

/** https only, no username/password, up to 500 characters. */
export function cleanRedirect(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function getSettings(env: Env, userId: number): Promise<SettingsRow | null> {
  return env.DB.prepare("SELECT * FROM pro_settings WHERE user_id = ?1").bind(userId).first<SettingsRow>();
}

const agendaOf = (s: SettingsRow | null): string[] => {
  try {
    const a = JSON.parse(s?.agenda ?? "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x).slice(0, 3) : [];
  } catch {
    return [];
  }
};

const logoUrl = (c: { env: Env } & Partial<Ctx>, userId: number, version: number) => (version ? `/brand/${userId}/logo?v=${version}` : null);

function shapeSettings(c: Ctx, userId: number, s: SettingsRow | null) {
  return {
    vanity: s?.vanity ?? null,
    vanityUrl: s?.vanity ? `${origin(c)}/${s.vanity}` : null,
    brandName: s?.brand_name ?? "",
    brandColor: s?.brand_color ?? "",
    logoUrl: s ? logoUrl(c, userId, s.logo_version) : null,
    welcome: s?.welcome ?? "",
    agenda: agendaOf(s),
    intakeQuestion: s?.intake_question ?? "",
    redirectUrl: s?.redirect_url ?? "",
  };
}

/** What a meeting page shows for an owner on Pro: their branding, waiting room and after-call page. */
export async function proForRoom(env: Env, owner: Pick<UserRow, "id" | "sub_status" | "plan">) {
  if (!isPro(env, owner)) return null;
  const s = await getSettings(env, owner.id);
  if (!s) return null;
  return {
    brand: { name: s.brand_name ?? "", color: s.brand_color ?? "", logoUrl: logoUrl({ env }, owner.id, s.logo_version) },
    waiting: { welcome: s.welcome ?? "", agenda: agendaOf(s), intakeQuestion: s.intake_question ?? "" },
    redirectUrl: s.redirect_url ?? "",
  };
}

/** meet.example.com/<name>: the owner's personal room, while they're on Pro. */
export async function resolveVanity(env: Env, name: string): Promise<{ room: string; ownerId: number } | null> {
  if (!VANITY_RE.test(name) || RESERVED.has(name)) return null;
  const r = await env.DB
    .prepare(
      `SELECT u.id, u.personal_room, u.sub_status, COALESCE(p.plan, 'host') AS plan
       FROM pro_settings s JOIN users u ON u.id = s.user_id LEFT JOIN user_plan p ON p.user_id = u.id WHERE s.vanity = ?1`
    )
    .bind(name)
    .first<{ id: number; personal_room: string; sub_status: string; plan: "host" | "pro" }>();
  if (!r || !isPro(env, r)) return null;
  return { room: r.personal_room, ownerId: r.id };
}

/* ---------- logo ---------- */

/** Works out the image type from its first bytes (never trusting the name or the browser). SVG isn't allowed: it can carry scripts. */
function imageType(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const MAX_LOGO = 200 * 1024;

async function uploadLogo(c: Ctx, u: UserRow): Promise<Response> {
  if (Number(c.req.headers.get("Content-Length") ?? 0) > MAX_LOGO) return fail("That image is too big. Please use one under 200 KB.", 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_LOGO) return fail("That image is too big. Please use one under 200 KB.", 413);
  const mime = imageType(bytes);
  if (!mime) return fail("Please upload a PNG, JPEG or WebP image.", 415);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO logos (user_id, mime, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET mime = ?2, data = ?3, updated_at = ?4").bind(u.id, mime, bytes, now),
    c.env.DB.prepare("INSERT INTO pro_settings (user_id, logo_version, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT(user_id) DO UPDATE SET logo_version = ?2, updated_at = ?2").bind(u.id, now),
  ]);
  return json({ settings: shapeSettings(c, u.id, await getSettings(c.env, u.id)) });
}

async function deleteLogo(c: Ctx, u: UserRow): Promise<Response> {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM logos WHERE user_id = ?1").bind(u.id),
    c.env.DB.prepare("UPDATE pro_settings SET logo_version = 0, updated_at = ?2 WHERE user_id = ?1").bind(u.id, Date.now()),
  ]);
  return json({ settings: shapeSettings(c, u.id, await getSettings(c.env, u.id)) });
}

/** GET /brand/<userId>/logo: the image, cached for a long time (the address changes when the logo does). */
export async function serveLogo(env: Env, userId: number): Promise<Response> {
  const r = await env.DB.prepare("SELECT mime, data FROM logos WHERE user_id = ?1").bind(userId).first<{ mime: string; data: ArrayBuffer | number[] }>();
  if (!r) return new Response("Not found", { status: 404 });
  const data = r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : new Uint8Array(r.data);
  return new Response(data, {
    headers: {
      "Content-Type": r.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}

/* ---------- settings ---------- */

async function saveSettings(c: Ctx, u: UserRow): Promise<Response> {
  const b = await body(c.req);
  const color = str(b.brandColor, 7).toLowerCase();
  if (color && !COLOR_RE.test(color)) return fail("Please choose a colour like #1d4ed8.");
  const redirect = str(b.redirectUrl, 500);
  const cleanUrl = redirect ? cleanRedirect(redirect) : "";
  if (cleanUrl === null) return fail('The after-call page must be a full https address, like "https://buy.stripe.com/...".');
  const agenda = (Array.isArray(b.agenda) ? b.agenda : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 3);
  const values = {
    brand_name: str(b.brandName, 60) || null,
    brand_color: color || null,
    welcome: multiline(b.welcome, 600) || null,
    agenda: agenda.length ? JSON.stringify(agenda) : null,
    intake_question: str(b.intakeQuestion, 200) || null,
    redirect_url: cleanUrl || null,
  };
  await c.env.DB
    .prepare(
      `INSERT INTO pro_settings (user_id, brand_name, brand_color, welcome, agenda, intake_question, redirect_url, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(user_id) DO UPDATE SET brand_name = ?2, brand_color = ?3, welcome = ?4, agenda = ?5, intake_question = ?6, redirect_url = ?7, updated_at = ?8`
    )
    .bind(u.id, values.brand_name, values.brand_color, values.welcome, values.agenda, values.intake_question, values.redirect_url, Date.now())
    .run();
  return json({ settings: shapeSettings(c, u.id, await getSettings(c.env, u.id)) });
}

async function checkVanity(c: Ctx, u: UserRow): Promise<Response> {
  const name = (c.url.searchParams.get("name") ?? "").trim().toLowerCase();
  const problem = vanityProblem(name);
  if (problem) return json({ available: false, reason: problem });
  const taken = await c.env.DB.prepare("SELECT user_id FROM pro_settings WHERE vanity = ?1").bind(name).first<{ user_id: number }>();
  return json({ available: !taken || taken.user_id === u.id, reason: taken && taken.user_id !== u.id ? "That name is taken." : null });
}

async function claimVanity(c: Ctx, u: UserRow): Promise<Response> {
  const b = await body(c.req);
  const name = str(b.name, 40).toLowerCase();
  if (name) {
    const problem = vanityProblem(name);
    if (problem) return fail(problem);
  }
  try {
    await c.env.DB
      .prepare("INSERT INTO pro_settings (user_id, vanity, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET vanity = ?2, updated_at = ?3")
      .bind(u.id, name || null, Date.now())
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return fail("That name is taken. Please choose another.", 409);
    throw err;
  }
  return json({ settings: shapeSettings(c, u.id, await getSettings(c.env, u.id)) });
}

/** Dashboard endpoints under /api/pro/. Reading is always allowed; changing anything needs Pro. */
export async function handlePro(c: Ctx, u: UserRow, path: string, method: string): Promise<Response | null> {
  if (!path.startsWith("/api/pro/")) return null;
  if (path === "/api/pro/settings" && method === "GET") return json({ settings: shapeSettings(c, u.id, await getSettings(c.env, u.id)) });
  if (!isPro(c.env, u)) return fail("This is a Pro feature. Upgrade to Pro on your dashboard to use it.", 402, { code: "pro_required" });
  if (path === "/api/pro/settings" && method === "POST") return saveSettings(c, u);
  if (path === "/api/pro/logo" && method === "POST") return uploadLogo(c, u);
  if (path === "/api/pro/logo/delete" && method === "POST") return deleteLogo(c, u);
  if (path === "/api/pro/vanity/check" && method === "GET") return checkVanity(c, u);
  if (path === "/api/pro/vanity" && method === "POST") return claimVanity(c, u);
  return null;
}
