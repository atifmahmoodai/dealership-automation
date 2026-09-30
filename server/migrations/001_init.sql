-- Dealership automation schema. Money is integer cents; times are timestamptz.

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'manager', 'sales')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id           text PRIMARY KEY,
  stock_no     text NOT NULL UNIQUE,
  vin          text NOT NULL DEFAULT '',
  year         integer NOT NULL,
  make         text NOT NULL,
  model        text NOT NULL,
  trim         text NOT NULL DEFAULT '',
  mileage      integer NOT NULL CHECK (mileage >= 0),
  fuel         text NOT NULL,
  transmission text NOT NULL,
  body         text NOT NULL DEFAULT '',
  colour       text NOT NULL DEFAULT '',
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  description  text NOT NULL DEFAULT '',
  photos       jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL CHECK (status IN ('available', 'reserved', 'sold', 'withdrawn')),
  sold_at      timestamptz,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One car per VIN while it's in stock.
CREATE UNIQUE INDEX vehicles_vin_live_key ON vehicles (vin) WHERE vin <> '' AND status IN ('available', 'reserved');

CREATE TABLE channels (
  id         text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('sandbox', 'webhook', 'feed')),
  enabled    boolean NOT NULL DEFAULT true,
  config     jsonb NOT NULL DEFAULT '{}',
  -- HMAC key for webhooks both ways, and the unguessable part of a feed URL.
  secret     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id             text PRIMARY KEY,
  vehicle_id     text NOT NULL REFERENCES vehicles(id),
  channel_id     text NOT NULL REFERENCES channels(id),
  wanted         boolean NOT NULL DEFAULT true,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('blocked', 'pending', 'live', 'error', 'removed')),
  external_id    text,
  published_hash text,
  problems       jsonb NOT NULL DEFAULT '{"errors": [], "warnings": []}',
  last_error     text,
  published_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, channel_id)
);
CREATE UNIQUE INDEX listings_external_key ON listings (channel_id, external_id) WHERE external_id IS NOT NULL;

-- "Bring this listing in line with the car." The worker decides what to send when it runs, from the car
-- as it is then, so a price edited three times while a site is down goes out once, with the last price.
-- At most one waiting job per listing; a change during a run sets rerun so it is picked up afterwards.
CREATE TABLE sync_jobs (
  id         bigserial PRIMARY KEY,
  listing_id text NOT NULL REFERENCES listings(id),
  rerun      boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts   integer NOT NULL DEFAULT 0,
  run_at     timestamptz NOT NULL DEFAULT now(),
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_jobs_one_waiting ON sync_jobs (listing_id) WHERE status IN ('queued', 'running');
CREATE INDEX sync_jobs_due ON sync_jobs (run_at) WHERE status = 'queued';

CREATE TABLE channel_log (
  id          bigserial PRIMARY KEY,
  channel_id  text NOT NULL REFERENCES channels(id),
  listing_id  text REFERENCES listings(id),
  action      text NOT NULL,
  ok          boolean NOT NULL,
  status      integer,
  duration_ms integer NOT NULL DEFAULT 0,
  detail      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_log_channel_idx ON channel_log (channel_id, at DESC);

-- The sandbox marketplaces' own side: what they would show on their sites.
CREATE TABLE sandbox_listings (
  channel_id  text NOT NULL REFERENCES channels(id),
  external_id text NOT NULL,
  payload     jsonb NOT NULL,
  removed     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, external_id)
);

CREATE TABLE buyers (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  email      text,
  phone      text NOT NULL DEFAULT '',
  opted_out  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX buyers_email_key ON buyers (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE conversations (
  id               text PRIMARY KEY,
  buyer_id         text NOT NULL REFERENCES buyers(id),
  vehicle_id       text NOT NULL REFERENCES vehicles(id),
  channel_id       text NOT NULL REFERENCES channels(id),
  thread_id        text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, thread_id)
);
CREATE INDEX conversations_vehicle_idx ON conversations (vehicle_id) WHERE status = 'open';

CREATE TABLE rules (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  trigger       text NOT NULL CHECK (trigger IN ('new_enquiry', 'no_reply', 'price_drop', 'sold')),
  delay_minutes integer NOT NULL CHECK (delay_minutes >= 0),
  template      text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id),
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  body            text NOT NULL,
  user_id         text REFERENCES users(id),
  rule_id         text REFERENCES rules(id),
  -- What made an automated message: a rule fires at most once per conversation and occasion.
  rule_key        text,
  status          text NOT NULL CHECK (status IN ('received', 'scheduled', 'sent', 'failed', 'suppressed', 'cancelled')),
  reason          text,
  external_id     text,
  attempts        integer NOT NULL DEFAULT 0,
  send_after      timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'in') = (status = 'received'))
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_due_idx ON messages (send_after) WHERE status = 'scheduled';
CREATE UNIQUE INDEX messages_rule_once ON messages (conversation_id, rule_id, rule_key) WHERE rule_id IS NOT NULL;
-- An inbound message delivered twice by a channel is stored once.
CREATE UNIQUE INDEX messages_inbound_once ON messages (conversation_id, external_id) WHERE direction = 'in';

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  details   jsonb NOT NULL DEFAULT '{}',
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
