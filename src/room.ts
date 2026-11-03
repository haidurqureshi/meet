import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// One Durable Object per meeting. It only passes small "signalling" messages between browsers (so they can
// find each other and set up their own direct connections) and relays chat text. Video and audio never come
// through here and nothing is stored.
//
// Up to MAX people. A person reconnecting with the same device id replaces their own old connection.
//
// To the browser:  {type:"joined", you, peers:[{id,name,host}]}  {type:"peer-joined", id, name, host}
//                  {type:"peer-left", id}  {type:"signal", from, data}  {type:"chat", from, name, text}  {type:"full"}
// From the browser: {type:"signal", to, data}  {type:"chat", text}

const MAX = 4;
// Flood protection per connection: a burst of up to BURST messages, refilling at RATE per second.
// Setting up a call sends a few dozen ICE candidates at once, so this is generous for real use.
const BURST = 200;
const RATE = 20;
const CHAT_BURST = 10;
const CHAT_RATE = 1;
type Who = { pid: string; name: string; host: boolean };
type Bucket = { tokens: number; chat: number; at: number };

export class RoomDO extends DurableObject<Env> {
  // In memory only: it resets if the object hibernates, which is fine for flood control.
  private buckets = new WeakMap<WebSocket, Bucket>();

  private allow(ws: WebSocket, chat: boolean): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: BURST, chat: CHAT_BURST, at: now };
    const dt = (now - b.at) / 1000;
    b.tokens = Math.min(BURST, b.tokens + dt * RATE);
    b.chat = Math.min(CHAT_BURST, b.chat + dt * CHAT_RATE);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1 || (chat && b.chat < 1)) return false;
    b.tokens--;
    if (chat) b.chat--;
    return true;
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }
  private who(ws: WebSocket): Who | null {
    return (ws.deserializeAttachment() as Who | null) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    const pid = u.searchParams.get("pid") ?? "";
    const name = (u.searchParams.get("name") ?? "").slice(0, 40);
    const host = u.searchParams.get("host") === "1";
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(pid)) return new Response("Bad id", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [pid]);
    server.serializeAttachment({ pid, name, host } satisfies Who);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    // The same person coming back (reload, flaky network, second tab) replaces their old connection.
    for (const old of this.ctx.getWebSockets(pid)) {
      if (old === server) continue;
      try {
        old.close(4001, "replaced");
      } catch {
        /* already closed */
      }
    }

    const others = this.open().filter((w) => w !== server && this.who(w)?.pid !== pid);
    if (others.length >= MAX) {
      server.send(JSON.stringify({ type: "full" }));
      server.close(4002, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const peers = others.map((w) => {
      const p = this.who(w)!;
      return { id: p.pid, name: p.name, host: p.host };
    });
    server.send(JSON.stringify({ type: "joined", you: pid, peers }));
    for (const o of others) o.send(JSON.stringify({ type: "peer-joined", id: pid, name, host }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 20_000) return;
    const me = this.who(ws);
    if (!me) return;
    let msg: { type?: string; to?: unknown; data?: unknown; text?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (!this.allow(ws, msg.type === "chat")) return;

    if (msg.type === "signal" && typeof msg.to === "string" && msg.to !== me.pid && msg.data && typeof msg.data === "object") {
      const out = JSON.stringify({ type: "signal", from: me.pid, data: msg.data });
      for (const w of this.ctx.getWebSockets(msg.to)) if (w.readyState === WebSocket.OPEN) w.send(out);
    } else if (msg.type === "chat" && typeof msg.text === "string") {
      const text = msg.text.trim().slice(0, 500);
      if (!text) return;
      const out = JSON.stringify({ type: "chat", from: me.pid, name: me.name, text });
      for (const w of this.open()) if (w !== ws && this.who(w)?.pid !== me.pid) w.send(out);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.left(ws);
  }
  webSocketError(ws: WebSocket): void {
    this.left(ws);
  }

  private left(ws: WebSocket): void {
    const me = this.who(ws);
    if (!me) return;
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
    // A replaced connection (same person already back) shouldn't announce that they left.
    if (this.open().some((w) => this.who(w)?.pid === me.pid)) return;
    for (const w of this.open()) w.send(JSON.stringify({ type: "peer-left", id: me.pid }));
  }
}
