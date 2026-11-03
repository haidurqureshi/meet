const enc = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alike characters
/** Uniformly random id from ALPHABET (rejection sampling, so no character is more likely than another). */
export function randomId(length: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/* ---------- passwords: PBKDF2-SHA256, 100,000 iterations (the most Cloudflare Workers allows) ---------- */

const ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256)
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const n = Number(iter);
  if (!Number.isInteger(n) || n < 1 || n > ITERATIONS) return false;
  try {
    return safeEqual(b64(await derive(password, unb64(salt), n)), hash);
  } catch {
    return false;
  }
}

/** Burns the same time as a real check, so unknown emails can't be told apart by speed. */
export async function fakeVerify(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITERATIONS);
}

/* ---------- login session cookie ---------- */

export const SESSION_COOKIE = "meet_session";
export const SESSION_S = 60 * 60 * 24 * 30;

async function fingerprint(passwordHash: string): Promise<string> {
  return (await sha256Hex(passwordHash)).slice(0, 12);
}

/** "<userId>.<expiry>.<password fingerprint>.<signature>": changing the password signs out every older session. */
export async function makeSession(secret: string, userId: number, passwordHash: string): Promise<string> {
  const payload = `${userId}.${Date.now() + SESSION_S * 1000}.${await fingerprint(passwordHash)}`;
  return `${payload}.${await hmacHex(secret, `session:${payload}`)}`;
}

export async function readSession(secret: string, value: string | undefined): Promise<{ id: number; fp: string } | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [id, exp, fp, sig] = parts;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(exp) || !/^[0-9a-f]+$/.test(fp) || Number(exp) < Date.now()) return null;
  return safeEqual(sig, await hmacHex(secret, `session:${id}.${exp}.${fp}`)) ? { id: Number(id), fp } : null;
}

export const passwordFingerprint = fingerprint;

/**
 * A participant's id in a room, derived from a secret only their browser knows. Other people in the meeting
 * see the id, but can't use it to take over that person's place (which would disconnect them and divert
 * the messages meant for them).
 */
export async function participantId(secret: string, room: string, deviceKey: string): Promise<string> {
  return (await hmacHex(secret, `pid:${room}:${deviceKey}`)).slice(0, 24);
}

/* ---------- meeting join tokens (checked when a browser opens the room's WebSocket) ---------- */

export type JoinPayload = { room: string; pid: string; name: string; host: boolean; exp: number };

export async function signJoin(secret: string, payload: JoinPayload): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmacHex(secret, `join:${body}`)}`;
}

export async function verifyJoin(secret: string, token: string | null): Promise<JoinPayload | null> {
  if (!token || token.length > 1200) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await hmacHex(secret, `join:${body}`))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as JoinPayload;
    if (typeof p.exp !== "number" || p.exp < Date.now()) return null;
    if (!/^[a-z2-9]{12}$/.test(p.room) || !/^[A-Za-z0-9_-]{8,40}$/.test(p.pid)) return null;
    return p;
  } catch {
    return null;
  }
}
