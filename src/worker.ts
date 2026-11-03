import { handleApi } from "./api";
import { verifyJoin } from "./crypto";
import type { Env } from "./env";

export { RoomDO } from "./room";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  // Camera, microphone and screen sharing only for this site's own pages.
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)",
};

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

async function socket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
  if (!env.SESSION_SECRET) return new Response("Not configured", { status: 503 });
  const who = await verifyJoin(env.SESSION_SECRET, url.searchParams.get("token"));
  if (!who) return new Response("This link has expired. Reload the page.", { status: 401 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(who.room));
  const q = new URLSearchParams({ pid: who.pid, name: who.name, host: who.host ? "1" : "0" });
  return stub.fetch(new Request(`https://room/connect?${q}`, request));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") return socket(request, env, url);
    if (path.startsWith("/api/")) return withHeaders(await handleApi(request, env, url, (p) => ctx.waitUntil(p)));

    // Meeting links: /m/<12 characters> all use the same room page (it asks the API what the meeting is).
    if (/^\/m\/[a-z2-9]{12}$/.test(path)) {
      const res = await env.ASSETS.fetch(new Request(new URL("/room", url), request));
      return withHeaders(res, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
