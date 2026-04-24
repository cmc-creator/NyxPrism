-- Run automatically on startup via src/index.js

CREATE TABLE IF NOT EXISTS users (
  id                     SERIAL PRIMARY KEY,
  firebase_uid           TEXT UNIQUE NOT NULL,
  email                  TEXT UNIQUE NOT NULL,
  first_name             TEXT,
  last_name              TEXT,
  plan                   TEXT NOT NULL DEFAULT 'trial',
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,
  subscription_status    TEXT NOT NULL DEFAULT 'trialing',
  trial_start            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_active           BOOLEAN NOT NULL DEFAULT TRUE,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
