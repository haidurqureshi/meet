# Meet: accounts, hosted video meetings, £10/month

A separate app (its own Worker, D1 database and Durable Objects; nothing to do with the tutoring site).
People **sign up free** with an email and password. **Hosting** meetings needs an active **£10/month** subscription (Stripe).
**Guests** join from a link with no account and it's free. Up to **4 people** per meeting, camera, microphone,
screen sharing and chat. Nothing is recorded.

| URL | What it is |
|---|---|
| `/` | Landing page, "paste a link to join" |
| `/signup`, `/login`, `/forgot`, `/reset`, `/verify` | Account pages |
| `/dashboard` | Subscription, instant meeting, personal room, scheduling + invitations, delete account |
| `/m/<code>` | The meeting room (the link you share) |
| `/legal` | Short terms and privacy notice (edit to suit you) |

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
- **Video:** WebRTC mesh: everyone connects to everyone, so 4 people means 3 connections each. **All media is relayed
  through Cloudflare TURN**, so nobody sees anyone's IP address and every call takes the same path. A small Durable
  Object per meeting (`src/room.ts`) only passes the "find each other" messages and chat. Bitrate is lowered
  automatically as more people join.

## Setup (about 20 minutes)

You need Node.js and a Cloudflare account on the Workers **Paid** plan (Durable Objects), plus a Stripe account.

```bash
npm install
npx wrangler login             # once
npm run db:remote              # creates the D1 database, puts its id in wrangler.jsonc, creates the tables
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

### Email (sign-up confirmation, password reset, invitations)

Uses Cloudflare Email Service (the `EMAIL` binding). The sender domain (`EMAIL_FROM`, default `no-reply@known.org.uk`) must be
onboarded: dashboard, **Compute**, **Email Service**, **Email Sending**. Until then emails fail quietly (the app keeps working,
and `npx wrangler tail` shows the error). To see links in the logs while testing, set `EMAIL_DEV_LOG=1` in `.dev.vars`.

### Your own address

Uncomment `routes` in `wrangler.jsonc`, e.g. `meet.known.org.uk` (the domain must be on Cloudflare), and deploy.
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

- 4 people per meeting (a mesh doesn't scale beyond that; going bigger means a media server such as Cloudflare Realtime SFU).
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
