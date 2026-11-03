import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { addRtkParticipant, createRtkMeeting, rtkConfigured, rtkMax } from "./realtimekit";

// One Durable Object per meeting. It only passes small "signalling" messages between browsers (so they can
// find each other and set up their own direct connections) and relays chat text. Video and audio never come
// through here and nothing is stored.
//
// Up to MAX people connect directly to each other ("mesh"). If a 5th person arrives and RealtimeKit is set up, the
// whole room switches to RealtimeKit (Cloudflare's media servers) for the rest of the meeting: everyone is told to
// "upgrade", and from then on this object only keeps track of who is here (for the people count, the size limit and
// chat) and hands out RealtimeKit tokens. Once everyone has left, the room goes back to mesh for next time.
// A person reconnecting with the same device id replaces their own old connection.
//
// To the browser:  {type:"joined", you, peers:[{id,name,host}], mode}  {type:"peer-joined", id, name, host}
//                  {type:"peer-left", id}  {type:"signal", from, data}  {type:"chat", from, name, text}  {type:"full"}
//                  {type:"upgrade"}
// From the browser: {type:"signal", to, data}  {type:"chat", text}
// From the Worker:  POST https://room/rtk-token {pid, name, host, title} -> {token} (only once the room has switched)

const MAX = 4;
type Mode = "mesh" | "rtk";
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

  // Only one RealtimeKit meeting per room, even when several people ask for a token at the same moment.
  private meetingPromise: Promise<string> | null = null;

  private async mode(): Promise<Mode> {
    return (await this.ctx.storage.get<Mode>("mode")) === "rtk" ? "rtk" : "mesh";
  }

  private rtkMeeting(title: string): Promise<string> {
    if (!this.meetingPromise) {
      this.meetingPromise = (async () => {
        const saved = await this.ctx.storage.get<string>("rtkMeetingId");
        if (saved) return saved;
        const id = await createRtkMeeting(this.env, title);
        await this.ctx.storage.put("rtkMeetingId", id);
        return id;
      })();
      this.meetingPromise.catch(() => (this.meetingPromise = null)); // try again next time
    }
    return this.meetingPromise;
  }

  private async rtkToken(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { pid?: string; name?: string; host?: boolean; title?: string };
    if (typeof b.pid !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(b.pid)) return Response.json({ error: "bad id" }, { status: 400 });
    if ((await this.mode()) !== "rtk") return Response.json({ error: "not_upgraded" }, { status: 409 });
    // Only people who are actually in this meeting (connected here) get a token.
    if (!this.ctx.getWebSockets(b.pid).some((w) => w.readyState === WebSocket.OPEN)) return Response.json({ error: "not_in_room" }, { status: 403 });
    try {
      const meetingId = await this.rtkMeeting(String(b.title ?? ""));
      const token = await addRtkParticipant(this.env, meetingId, { id: b.pid, name: String(b.name ?? "").slice(0, 40), host: b.host === true });
      return Response.json({ token });
    } catch (err) {
      console.error("RealtimeKit token failed:", err);
      return Response.json({ error: "rtk_failed" }, { status: 502 });
    }
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }
  private who(ws: WebSocket): Who | null {
    return (ws.deserializeAttachment() as Who | null) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/rtk-token" && request.method === "POST") return this.rtkToken(request);
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
    let mode = await this.mode();
    const limit = mode === "rtk" ? rtkMax(this.env) : MAX;
    if (others.length >= limit) {
      // A 5th person: switch the whole room to RealtimeKit if it's set up, otherwise the room is full.
      if (mode === "mesh" && rtkConfigured(this.env) && others.length < rtkMax(this.env)) {
        mode = "rtk";
        await this.ctx.storage.put("mode", mode);
        for (const o of others) o.send(JSON.stringify({ type: "upgrade" }));
      } else {
        server.send(JSON.stringify({ type: "full", max: limit }));
        server.close(4002, "full");
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    const peers = others.map((w) => {
      const p = this.who(w)!;
      return { id: p.pid, name: p.name, host: p.host };
    });
    server.send(JSON.stringify({ type: "joined", you: pid, peers, mode }));
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

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  private async left(ws: WebSocket): Promise<void> {
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
    // Everyone has gone: the next call in this room starts as a direct (mesh) call again.
    // The RealtimeKit meeting id is kept, so a later large call reuses the same meeting.
    if (this.open().length === 0) await this.ctx.storage.delete("mode");
  }
}
