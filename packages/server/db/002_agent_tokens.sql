-- 002_agent_tokens.sql — token storage for the credential handoff.
-- We store ONLY hashes (Bun.hash / wyhash-64), never raw tokens.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS agent_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_name  text NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('bootstrap','access')),
  token_hash  text NOT NULL,                 -- Bun.hash(`${kind}:${raw}`).toString(16) — 16 hex chars
  expires_at  timestamptz,                   -- bootstrap: now()+1h; access: NULL (long-lived)
  used_at     timestamptz,                   -- bootstrap: set when spent; access: always NULL
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_name);
