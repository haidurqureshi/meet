import type { Env } from "./env";

// Minimal Cloudflare RealtimeKit REST client (fetch only, no SDK).
// Used when a meeting grows past what a direct (mesh) call handles: everyone then switches to RealtimeKit,
// where Cloudflare's media servers forward each person's video to the others.
//
// API: https://api.cloudflare.com/client/v4/accounts/{account}/realtime/kit/{app}/...
// Needs an API token with Realtime permissions for the account.

const API = "https://api.cloudflare.com/client/v4";

export const DEFAULT_RTK_MAX = 20;

/** True when everything needed to use RealtimeKit is set. Without it, meetings stay at 4 people. */
export function rtkConfigured(env: Env): boolean {
  return !!(env.RTK_ACCOUNT_ID?.trim() && env.RTK_APP_ID?.trim() && env.RTK_API_TOKEN?.trim());
}

/** The most people allowed in a meeting once it has switched to RealtimeKit. */
export function rtkMax(env: Env): number {
  const n = Number.parseInt(env.RTK_MAX_PARTICIPANTS ?? "", 10);
  return Number.isFinite(n) && n > 4 && n <= 100 ? n : DEFAULT_RTK_MAX;
}

/** Local testing only: RTK_API_BASE may point at a stand-in API on this machine, never anywhere else. */
function apiBase(env: Env): string {
  const b = env.RTK_API_BASE?.trim();
  return b && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(b) ? b.replace(/\/$/, "") : API;
}

async function call<T>(env: Env, path: string, body: unknown): Promise<T> {
  const url = `${apiBase(env)}/accounts/${encodeURIComponent(env.RTK_ACCOUNT_ID!.trim())}/realtime/kit/${encodeURIComponent(env.RTK_APP_ID!.trim())}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RTK_API_TOKEN!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: { success?: boolean; data?: T; errors?: { message?: string }[]; error?: { message?: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (!res.ok || json.success === false || !json.data) {
    const why = json.errors?.[0]?.message ?? json.error?.message ?? text.slice(0, 200);
    throw new Error(`RealtimeKit ${path} failed (HTTP ${res.status}): ${why}`);
  }
  return json.data;
}

export async function createRtkMeeting(env: Env, title: string): Promise<string> {
  const m = await call<{ id: string }>(env, "/meetings", { title: title.slice(0, 100) || "Meeting" });
  return m.id;
}

/** Adds someone to a RealtimeKit meeting and returns the token their browser joins with. */
export async function addRtkParticipant(
  env: Env,
  meetingId: string,
  p: { id: string; name: string; host: boolean }
): Promise<string> {
  const preset = (p.host ? env.RTK_PRESET_HOST : env.RTK_PRESET_GUEST)?.trim() || (p.host ? "group_call_host" : "group_call_participant");
  const r = await call<{ token: string }>(env, `/meetings/${encodeURIComponent(meetingId)}/participants`, {
    name: p.name || "Guest",
    preset_name: preset,
    custom_participant_id: p.id,
  });
  return r.token;
}
