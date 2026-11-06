import { handleApi, sameOrigin } from "./api";
import { verifyJoin } from "./crypto";
import type { Env } from "./env";

export { RoomDO } from "./room";

function securityHeaders(url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Camera, microphone and screen sharing only for this site's own pages.
    "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
    // Only this site's own scripts and styles run: no inline scripts, nothing from other sites.
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      // RealtimeKit (only used once a meeting grows past 4 people) talks to Cloudflare's realtime servers
      // and runs a small timer worker from a blob: URL.
      "connect-src 'self' https://*.realtime.cloudflare.com wss://*.realtime.cloudflare.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
  if (url.protocol === "https:") headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function withHeaders(res: Response, url: URL, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...securityHeaders(url), ...extra })) out.headers.set(k, v);
  return out;
}

/**
 * True only under `wrangler dev`. On Cloudflare, CF-Connecting-IP is always the real visitor's address (set by the
 * edge and can't be faked), so it's never a loopback address.
 */
const isLocal = (request: Request) => ["127.0.0.1", "::1"].includes(request.headers.get("CF-Connecting-IP") ?? "");

/** The testing switches (.dev.vars) only ever work locally, so setting one by mistake in production does nothing. */
function effectiveEnv(env: Env, request: Request): Env {
  // Locally, links point at this machine rather than the live site.
  if (isLocal(request)) return env.PUBLIC_URL ? { ...env, PUBLIC_URL: undefined } : env;
  if (!env.DEV_SKIP_BILLING && !env.RTC_ALLOW_DIRECT && !env.EMAIL_DEV_LOG) return env;
  return { ...env, DEV_SKIP_BILLING: undefined, RTC_ALLOW_DIRECT: undefined, EMAIL_DEV_LOG: undefined };
}

async function socket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
  if (!env.SESSION_SECRET) return new Response("Not configured", { status: 503 });
  const who = await verifyJoin(env.SESSION_SECRET, url.searchParams.get("token"));
  if (!who) return new Response("This link has expired. Reload the page.", { status: 401 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(who.room));
  const q = new URLSearchParams({ pid: who.pid, name: who.name, host: who.host ? "1" : "0" });
  return stub.fetch(new Request(`https://room/connect?${q}`, request));
}

export default {
  async fetch(request, rawEnv, ctx): Promise<Response> {
    const url = new URL(request.url);
    const env = effectiveEnv(rawEnv, request);
    const path = url.pathname;

    if (path === "/ws") return socket(request, env, url);
    if (path.startsWith("/api/")) {
      let res: Response;
      try {
        res = await handleApi(request, env, url, (p) => ctx.waitUntil(p));
      } catch (err) {
        console.error("Unhandled API error:", err);
        res = new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return withHeaders(res, url);
    }

    // Meeting links: /m/<12 characters> all use the same room page (it asks the API what the meeting is).
    if (/^\/m\/[a-z2-9]{12}$/.test(path)) {
      const res = await env.ASSETS.fetch(new Request(new URL("/room", url), request));
      return withHeaders(res, url, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    }
    return withHeaders(await env.ASSETS.fetch(request), url);
  },
} satisfies ExportedHandler<Env>;
