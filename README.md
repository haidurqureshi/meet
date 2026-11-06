# Meet: accounts, hosted video meetings, £10/month

A separate app (its own Worker, D1 database and Durable Objects; nothing to do with the tutoring site).
People **sign up free** with an email and password. **Hosting** meetings needs an active **£10/month** subscription (Stripe).
**Guests** join from a link with no account and it's free. Up to **4 people** per meeting (or up to 20 with the optional
RealtimeKit setup below), camera, microphone, screen sharing and chat. Nothing is recorded.

| URL | What it is |
|---|---|
| `/` | Landing page, "paste a link to join" |
| `/signup`, `/login`, `/forgot`, `/reset`, `/verify` | Account pages |
| `/dashboard` | Subscription, instant meeting, personal room, scheduling + invitations, delete account |
| `/m/<code>` | The meeting room (the link you share) |
| `/legal` | Short terms and privacy notice (edit to suit you) |
| `/developers` | API docs for another site (e.g. a tutoring site) that creates meetings and join links |

## How it works

- **Accounts:** email + password (PBKDF2, 100,000 rounds), sessions in an HttpOnly cookie that stops working when the
  password changes. Sign-up, login and reset requests are rate limited and sign-up has a hidden honeypot field.
- **Subscription:** Stripe Checkout (monthly, GBP), Stripe's billing portal for cancelling or changing the card, and a
  webhook that keeps the status up to date. Hosting is allowed while the status is `active` or `trialing`.
  If a subscription lapses, the host's scheduled links and personal room stop opening until they resubscribe.
- **Meetings:** each host has a **personal room** (a permanent link), can start an **instant meeting**, or **schedule** one
  and send **email invitations** (up to 10 at a time, 30 a day; the host must have confirmed their email first).
  A scheduled room opens 15 minutes before the start and closes an hour after it is due to end. The host can enter early.
- **Security:** a strict Content-Security-Policy (only this site's own scripts), HSTS, no framing, and API calls must
  come from this site's own pages as JSON. Emailed links work once. Each person's place in a meeting is tied to a secret
  their browser holds, so others in the call can't take it over. The room server limits how fast anyone can send messages.
  A host can replace their personal room link from the dashboard if it has been shared too widely.
- **In a call:** a full-screen dark call view with icon controls (M mutes, V turns the camera on or off). Everyone
  can see who is muted, who has their camera off (their initials are shown instead) and who is speaking. Speaker view (the default) shows the others big and
  your own camera small in a corner you can drag it to; the View button or G switches to an equal-sized gallery. Click a
  tile to make it big. Chat opens as a side panel (a drawer on phones) with an unread count.
- **Permissions:** in a call, the host opens **People** to allow or stop each person's mic, camera, screen share and
  chat, or set it for everyone (e.g. "only the host shares their screen"). The room server keeps the permissions and only
  accepts changes from the host. Chat is blocked on the server. For mic, camera and screen share, the person's own
  buttons are switched off and locked, and everyone else's page stops playing that person's sound or video, so a modified
  page can't get round it. "Everyone" settings are kept for the room; per-person ones are forgotten once everyone leaves.
- **API for other sites:** a host creates an API key on the dashboard and gives it to another site's developer (docs at
  `/developers`). That site's server can create, reschedule, list and cancel meetings (with its own `externalId`, so
  retries never make duplicates) and get **personal join links**: e.g. the tutor as host, the student as guest, each
  with their name filled in and no account needed. Keys are stored only as a hash, can be deleted any time, are rate
  limited, and only work from a server. The API (and creating keys) needs an active host subscription.
- **Embedding:** each join link also comes with a ready-made `<iframe>`, so the other site can show the meeting inside
  its own page. The host lists which websites may do this on the dashboard; meeting pages allow framing only by those
  sites (and only while the host is subscribed), every other page can't be framed. Inside a frame the meeting hides
  this site's links and tells the parent page what's happening (`ready`, `joined`, `people`, `left`, `ended`).
- **Video:** WebRTC mesh: everyone connects to everyone, so 4 people means 3 connections each. **All media is relayed
  through Cloudflare TURN**, so nobody sees anyone's IP address and every call takes the same path. A small Durable
  Object per meeting (`src/room.ts`) only passes the "find each other" messages and chat. Bitrate is lowered
  automatically as more people join.

## Setup (about 20 minutes)

You need Node.js and a Cloudflare account on the Workers **Paid** plan (Durable Objects), plus a Stripe account.

```bash
npm install
npx wrangler login             # once
npm run db:remote              # creates the D1 database, puts its id in wrangler.jsonc, creates the tables (safe to re-run after updates)
npm run deploy
```

If a Worker called `meet-app` already exists in your account, deploying **replaces it**. Change `name` in `wrangler.jsonc` first if needed.

Then set the secrets (the Worker has to exist, so do this after the first deploy):

```bash
npx wrangler secret put SESSION_SECRET        # any long random string, e.g. from: openssl rand -base64 32
npx wrangler secret put TURN_KEY_API_TOKEN    # see "TURN" below
npx wrangler secret put STRIPE_SECRET_KEY     # see "Stripe" below
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Cloudflare TURN (required)

1. Cloudflare dashboard, **Realtime**, **TURN**, **Create TURN key**. Copy the **Key ID** and **API token** (shown once).
2. Put the Key ID in `wrangler.jsonc` as `TURN_KEY_ID` (not secret). Put the token in the `TURN_KEY_API_TOKEN` secret.
3. `npm run deploy`.

**Cost:** Cloudflare's docs say the first 1,000 GB of relayed data per month is free (shared with their other
Realtime services), then $0.05 per GB. In a 4-person call each person uploads their video three times and everything is relayed,
so a rough guide is **1 to 2 GB per person per hour** at 3 other people (the app caps bitrates to keep this down).
Check Cloudflare's Realtime pricing page for current numbers. At £10 a month per host this leaves plenty of margin, but watch it.

### Stripe (the £10/month)

1. Stripe dashboard, **Developers, API keys**: copy the **secret key** (`sk_live_...`, or `sk_test_...` to try it first) into `STRIPE_SECRET_KEY`.
2. **Developers, Webhooks, Add endpoint**: URL `https://<your-worker-address>/api/stripe/webhook`. Select these events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the **signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
3. **Settings, Billing, Customer portal**: switch it on and allow cancelling subscriptions.
4. The price is `PRICE_PENCE` in `wrangler.jsonc` (`1000` = £10). Or create a recurring Price in Stripe and put its `price_...` id in `STRIPE_PRICE_ID`.

After paying, the person is sent back to the dashboard and the app confirms the payment straight with Stripe, so access
appears immediately; the webhook then keeps renewals, failed payments and cancellations in sync.

### Larger meetings: Cloudflare RealtimeKit (optional)

Calls start as direct connections (free apart from TURN data). If a **5th person** joins and RealtimeKit is set up,
the whole meeting switches to Cloudflare RealtimeKit, where Cloudflare's media servers forward each person's video to
everyone else, so it works for bigger groups. Everyone's screen switches over by itself in a second or two (the call
looks the same; chat and the people count keep working) and the meeting stays on RealtimeKit until everyone has left.
Without this setup, the 5th person sees "Meeting is full", as before.

1. Cloudflare dashboard, **Realtime**, **RealtimeKit**: create an app. Copy the **App ID**.
2. In that app, check the **Presets**. The app uses `group_call_host` for the host and `group_call_participant` for
   everyone else. If yours are named differently, put their names in `RTK_PRESET_HOST` / `RTK_PRESET_GUEST`.
3. Create an **API token** (My Profile, API Tokens) with **Realtime** edit permission for your account.
4. In `wrangler.jsonc` set `RTK_ACCOUNT_ID` (your account ID, shown on the dashboard's overview page) and `RTK_APP_ID`.
   `RTK_MAX_PARTICIPANTS` (default 20) caps meetings once they've switched.
5. `npx wrangler secret put RTK_API_TOKEN`, then `npm run deploy`.

**Cost:** RealtimeKit is billed per participant minute. Check Cloudflare's RealtimeKit pricing before turning it on.
Only meetings that actually grow past 4 people use it. The browser part of RealtimeKit (`public/vendor/realtimekit-2.0.4.js`,
Apache-2.0, from the `@cloudflare/realtimekit` npm package) is served from this site rather than a CDN.

**If a switch fails** ("Couldn't move the call"), `npx wrangler tail` shows why (e.g. a wrong App ID, token or preset name).

### Email (sign-up confirmation, password reset, invitations)

Uses Cloudflare Email Service (the `EMAIL` binding). The sender domain (`EMAIL_FROM`, default `no-reply@meet.haidurqureshi.com`) must be
onboarded: dashboard, **Compute**, **Email Service**, **Email Sending**. Until then emails fail quietly (the app keeps working,
and `npx wrangler tail` shows the error). To see links in the logs while testing, set `EMAIL_DEV_LOG=1` in `.dev.vars`.

### Your own address

Uncomment `routes` in `wrangler.jsonc`, e.g. `meet.haidurqureshi.com` (the domain must be on Cloudflare), and deploy.
Use the same address in the Stripe webhook URL.

## Local testing

```bash
cp .dev.vars.example .dev.vars     # fill in values (never commit .dev.vars)
npm run db:local                   # creates the local tables
npm run dev                        # http://localhost:8787
```

In `.dev.vars`: `RTC_ALLOW_DIRECT=1` lets calls connect without a TURN key; `DEV_SKIP_BILLING=1` treats every account as
subscribed so you can try meetings without Stripe; `EMAIL_DEV_LOG=1` prints emails to the console.
They only take effect under `wrangler dev` (they're ignored on Cloudflare), but still don't set them in production. `npm run typecheck` checks the code.

## Limits

- 4 people per meeting on direct connections (a mesh doesn't scale beyond that). With RealtimeKit set up, meetings switch
  over automatically from the 5th person, up to `RTK_MAX_PARTICIPANTS`.
- Screen sharing works on desktop browsers; phones can watch a shared screen but not share one.
- Camera and microphone need `https://` (workers.dev and custom domains both are) or `localhost`.
- No recording, waiting room or whiteboard. Anyone with a meeting link can join as a guest, so send links only to the people you mean.
- Deleting an account needs the subscription cancelled first. Invitations can't be recalled once sent.
- The terms page is a plain-English starting point, not legal advice. Have it reviewed before taking payments.

## Troubleshooting

- **"Not set up yet: the SESSION_SECRET secret is missing"**: set the secrets above.
- **"Video isn't switched on yet"**: the TURN key isn't set up or is wrong. Check `TURN_KEY_ID` and the secret, then `npx wrangler tail` and look for "Could not get TURN credentials".
- **Stuck on "Connecting…"**: no working TURN key, or the person's network blocks Cloudflare TURN. Try another network.
- **Paid but still "not subscribed"**: check the webhook endpoint in Stripe (recent deliveries, signing secret matches `STRIPE_WEBHOOK_SECRET`).
- **No emails**: the sender domain isn't onboarded yet; check `npx wrangler tail`.
- **"The browser is blocking the camera"**: click the camera icon in the address bar, allow access, then reload.
