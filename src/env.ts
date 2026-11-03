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
  PRICE_PENCE: string;
  STRIPE_PRICE_ID?: string;
  EMAIL_FROM?: string;
  TURN_KEY_ID?: string;
  // secrets (npx wrangler secret put <NAME>)
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURN_KEY_API_TOKEN?: string;
  // local testing only (.dev.vars)
  RTC_ALLOW_DIRECT?: string;
  EMAIL_DEV_LOG?: string;
  DEV_SKIP_BILLING?: string;
}
