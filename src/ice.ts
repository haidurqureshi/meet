import type { Env } from "./env";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type IceConfig = { iceServers: IceServer[]; relayOnly: boolean };

/**
 * All media goes through Cloudflare TURN (relay-only): people never see each other's IP addresses and every
 * call takes the same path. Null means TURN isn't set up. (RTC_ALLOW_DIRECT=1 is for local testing only.)
 */
export async function getIce(env: Env, ttlSeconds: number): Promise<IceConfig | null> {
  const direct: IceConfig = { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], relayOnly: false };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return env.RTC_ALLOW_DIRECT === "1" ? direct : null;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { iceServers?: IceServer[] };
    const turn = (data.iceServers ?? []).filter((s) => s.credential);
    if (!turn.length) throw new Error("no TURN servers returned");
    return { iceServers: turn, relayOnly: true };
  } catch (err) {
    console.error("Could not get TURN credentials:", err);
    return env.RTC_ALLOW_DIRECT === "1" ? direct : null;
  }
}
