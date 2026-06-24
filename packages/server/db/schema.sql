-- agent-chat MVP schema
-- Natural keys (names) to match the existing wire protocol / in-memory maps.
-- Idempotent: safe to re-run.

-- ── agents ────────────────────────────────────────────────────────────────
-- Registry of created agents (forward-looking for the create-agent pillar).
-- Humans are NOT stored here; sender_name in messages is plain text.
CREATE TABLE IF NOT EXISTS agents (
  name          text PRIMARY KEY,
  description   text,
  system_prompt text,
  model         text,
  provider      text,
  status        text NOT NULL DEFAULT 'offline',
  container_id  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── channels ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  name        text PRIMARY KEY,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── channel_members ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_members (
  channel_name text NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  member_name  text NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_name, member_name)
);

-- ── messages ───────────────────────────────────────────────────────────────
-- Unified global / dm / channel_message, mirroring StoredMessage.
CREATE TABLE IF NOT EXISTS messages (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('message','dm','channel_message')),
  sender_name    text NOT NULL,
  body           text NOT NULL,
  recipient_name text,                                    -- dm only (= StoredMessage.to)
  channel_name   text REFERENCES channels(name) ON DELETE CASCADE,  -- channel only
  time_ms        bigint NOT NULL,                         -- = StoredMessage.time (epoch ms)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel_name);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_name);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_name);
CREATE INDEX IF NOT EXISTS idx_messages_kind      ON messages(kind);
