-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum types
CREATE TYPE sync_status AS ENUM (
  'received',
  'processing',
  'synced',
  'failed',
  'skipped_stale'
);

CREATE TYPE event_direction AS ENUM (
  'inbound',
  'outbound'
);

-- Raw webhook payloads (immutable append-only log)
CREATE TABLE raw_webhooks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload        JSONB NOT NULL,
  headers        JSONB NOT NULL DEFAULT '{}',
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_raw_webhooks_unprocessed
  ON raw_webhooks (received_at)
  WHERE processed = FALSE;

-- Contacts (materialized internal state)
CREATE TABLE contacts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_contact_id      VARCHAR(255) NOT NULL UNIQUE,
  email                   VARCHAR(255),
  first_name              VARCHAR(255),
  last_name               VARCHAR(255),
  lahzo_score             INTEGER,
  lahzo_status            VARCHAR(50),
  sync_status             sync_status NOT NULL DEFAULT 'received',
  last_error              TEXT,
  last_event_occurred_at  TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contacts_sync_status ON contacts (sync_status);

-- Sync events (full audit trail)
CREATE TABLE sync_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hubspot_event_id  VARCHAR(255) UNIQUE,
  direction         event_direction NOT NULL,
  event_type        VARCHAR(100) NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  status            sync_status NOT NULL DEFAULT 'received',
  error_message     TEXT,
  occurred_at       TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_events_contact_history
  ON sync_events (contact_id, created_at DESC);

CREATE INDEX idx_sync_events_status
  ON sync_events (status)
  WHERE status IN ('failed', 'processing');

-- Operator users (authentication)
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(255) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
