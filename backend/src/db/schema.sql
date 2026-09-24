-- Run automatically on startup via src/index.js

CREATE TABLE IF NOT EXISTS users (
  id                     SERIAL PRIMARY KEY,
  firebase_uid           TEXT UNIQUE NOT NULL,
  email                  TEXT UNIQUE NOT NULL,
  first_name             TEXT,
  last_name              TEXT,
  plan                   TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,
  subscription_status    TEXT NOT NULL DEFAULT 'active',
  trial_start            TIMESTAMPTZ DEFAULT NULL,
  trial_active           BOOLEAN NOT NULL DEFAULT FALSE,
  current_period_end     TIMESTAMPTZ,
  is_admin               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add is_admin to pre-existing deployments
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';
ALTER TABLE users ALTER COLUMN subscription_status SET DEFAULT 'active';
ALTER TABLE users ALTER COLUMN trial_start DROP NOT NULL;
ALTER TABLE users ALTER COLUMN trial_start SET DEFAULT NULL;
ALTER TABLE users ALTER COLUMN trial_active SET DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS contact_messages (
  id         SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'My API Key',
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS signature_requests (
  id            SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_mime TEXT NOT NULL DEFAULT 'application/pdf',
  document_size INTEGER,
  document_data BYTEA,
  document_hash TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_mime TEXT NOT NULL DEFAULT 'application/pdf';
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_size INTEGER;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_data BYTEA;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_hash TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE signature_requests SET expires_at = created_at + INTERVAL '30 days' WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS signature_recipients (
  id           SERIAL PRIMARY KEY,
  request_id   INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  role_order   INTEGER NOT NULL DEFAULT 1,
  token        TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending',
  viewed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  consented_at TIMESTAMPTZ,
  completion_hash TEXT,
  declined_at  TIMESTAMPTZ,
  decline_reason TEXT
);
ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;
ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;
ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS completion_hash TEXT;

CREATE TABLE IF NOT EXISTS signature_fields (
  id           SERIAL PRIMARY KEY,
  request_id   INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES signature_recipients(id) ON DELETE CASCADE,
  field_type   TEXT NOT NULL,
  page_number  INTEGER NOT NULL DEFAULT 1,
  x            NUMERIC NOT NULL,
  y            NUMERIC NOT NULL,
  width        NUMERIC NOT NULL,
  height       NUMERIC NOT NULL,
  required     BOOLEAN NOT NULL DEFAULT TRUE,
  label        TEXT,
  value_text   TEXT,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE signature_fields ADD COLUMN IF NOT EXISTS value_text TEXT;
ALTER TABLE signature_fields ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS signature_audit_events (
  id           SERIAL PRIMARY KEY,
  request_id   INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES signature_recipients(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  detail       TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signature_notifications (
  id              SERIAL PRIMARY KEY,
  request_id      INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  recipient_id    INTEGER REFERENCES signature_recipients(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signature_alert_acknowledgements (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS distribution_batches (
  id            SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_mime TEXT NOT NULL DEFAULT 'application/pdf',
  document_size INTEGER,
  document_data BYTEA NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);
ALTER TABLE distribution_batches ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE distribution_batches SET expires_at = created_at + INTERVAL '30 days' WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS distribution_recipients (
  id        SERIAL PRIMARY KEY,
  batch_id  INTEGER NOT NULL REFERENCES distribution_batches(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  email     TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL DEFAULT 'queued',
  sent_at   TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
