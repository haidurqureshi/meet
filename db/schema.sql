-- Safe to run repeatedly (everything is IF NOT EXISTS).
-- Times are stored as epoch milliseconds (UTC).

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL UNIQUE,            -- lowercase
  name               TEXT    NOT NULL,
  password_hash      TEXT    NOT NULL,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  personal_room      TEXT    NOT NULL UNIQUE,            -- id of the user's permanent personal meeting link
  stripe_customer_id TEXT,
  stripe_sub_id      TEXT,
  sub_status         TEXT    NOT NULL DEFAULT 'none',    -- none | active | trialing | past_due | canceled | ...
  sub_period_end     INTEGER,                            -- epoch ms: current paid period ends
  sub_cancel_at_end  INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users (stripe_customer_id);

-- One-time links sent by email. Only a SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('reset', 'verify')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT    PRIMARY KEY,                      -- random 12 characters, part of the join link
  owner_id     INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  starts_at    INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  tz           TEXT    NOT NULL,                         -- the host's time zone, used to word invitation emails
  kind         TEXT    NOT NULL CHECK (kind IN ('scheduled', 'instant')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings (owner_id, starts_at);

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  sent_at    INTEGER NOT NULL,
  UNIQUE (meeting_id, email)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT    NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits (key, ts);

-- Stripe webhook events already handled (so a retried event is never applied twice)
CREATE TABLE IF NOT EXISTS stripe_events (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL
);
