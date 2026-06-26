-- agent-chat 003: system-prompt generation provenance
-- Idempotent: safe to re-run.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS prompt_generated_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS prompt_gen_model text;
