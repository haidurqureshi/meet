export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DB: D1Database;
  EMAIL?: {
    send(message: {
      to: string | string[];
      from: string | { email: string; name?: string };
      subject: string;
      text?: string;
      html?: string;
    }): Promise<{ messageId: string }>;
  };
  // vars (wrangler.jsonc)
  APP_NAME: string;
  PUBLIC_URL?: string; // the site's address, e.g. https://meet.example.com (used for links in emails and API answers)
  PRO_PRICE_PENCE?: string;
  BUSINESS_PRICE_PENCE?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_BUSINESS_PRICE_ID?: string;
  FREE_GROUP_MINUTES?: string; // how long 3-4 person calls last on the Free plan (default 45)
  EMAIL_FROM?: string;
  CONTACT_EMAIL?: string; // shown as "Contact us" for the Enterprise plan
  TURN_KEY_ID?: string;
  // Cloudflare RealtimeKit, used when a meeting grows past 4 people (all optional; without them meetings stay at 4)
  RTK_ACCOUNT_ID?: string;
  RTK_APP_ID?: string;
  RTK_PRESET_HOST?: string;
  RTK_PRESET_GUEST?: string;
  // secrets (npx wrangler secret put <NAME>)
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURN_KEY_API_TOKEN?: string;
  RTK_API_TOKEN?: string;
  // local testing only (.dev.vars)
  RTC_ALLOW_DIRECT?: string;
  EMAIL_DEV_LOG?: string;
  DEV_SKIP_BILLING?: string;
  RTK_API_BASE?: string; // a stand-in RealtimeKit API on localhost (ignored unless it's a localhost address)
}
