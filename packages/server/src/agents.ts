/**
 * agents.ts — DB-backed agent registry + credential-handoff token logic.
 *
 * Lifecycle:
 *   createAgent()   → status='created',  mints bootstrap + access token hashes
 *   bootstrapAgent() → status='provisioned', mints fresh access token (bootstrap is reusable)
 *   WS join          → status='online'   (validated via validateAccessToken)
 *   disconnect       → status='offline'
 *   stop             → status='stopped'
 *
 * Bootstrap tokens are REUSABLE (no TTL, no one-time) so an agent can restart
 * and re-bootstrap. They live until the agent is deleted (FK ON DELETE CASCADE).
 * Access tokens are minted fresh on each bootstrap; prior ones are invalidated.
 */
import { sql } from "./db";
import { mintToken, hashToken, type TokenKind } from "./tokens";
import { getProviderKey } from "./credentials";
import { generateSystemPrompt } from "./prompt-gen";

// ── Defaults (match today's single-agent setup) ───────

const DEFAULT_PROVIDER = "fireworks";
const DEFAULT_MODEL = "accounts/fireworks/models/glm-5p1";

// ── Types ─────────────────────────────────────────────

export type AgentStatus = "created" | "provisioned" | "online" | "offline" | "stopped";

export interface AgentRow {
  name: string;
  description: string | null;
  system_prompt: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  container_id: string | null;
  created_at: string;
}

export interface CreateAgentInput {
  description: string;
  name?: string;
  provider?: string;
  model?: string;
}

export interface CreateAgentResult {
  name: string;
  command: string;
  token: string;
}

export interface BootstrapResult {
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  apiKey: string;
  accessToken: string;
  wsUrl: string;
}

export class AgentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ── Name generation (copied from packages/agent/src/names.ts to avoid a cross-package import) ──

const BASE_NAMES = [
  "louey","johnny","paully","vinnie","frankie","tony","sal","gino","rocco","donnie",
  "mikey","nicky","carmine","joey","richie","bobby","enzo","carlo","petey","eddie",
  "sammy","dominic","lenny","vito","sonny","marco","dino","cosmo","ralphie","bruno",
];

function generateName(): string {
  return BASE_NAMES[Math.floor(Math.random() * BASE_NAMES.length)];
}

async function generateUniqueName(): Promise<string> {
  const taken = new Set<string>();
  const rows = await sql<{ name: string }[]>`SELECT name FROM agents`;
  for (const r of rows) taken.add(r.name);

  // Try base names a few times
  for (let i = 0; i < 30; i++) {
    const name = generateName();
    if (!taken.has(name)) return name;
  }
  // Fallback — append a short random suffix
  return `agent-${Math.random().toString(36).slice(2, 8)}`;
}

// ── CRUD ──────────────────────────────────────────────

/** Create a new agent, mint tokens, and return the run command. */
export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const name = input.name?.trim() || await generateUniqueName();
  const provider = input.provider?.trim() || DEFAULT_PROVIDER;
  const model = input.model?.trim() || DEFAULT_MODEL;
  // Generate the system prompt via an LLM call (falls back to description if
  // no key configured or the call fails).
  const gen = await generateSystemPrompt(input.description);
  const systemPrompt = gen?.prompt ?? input.description.trim();

  // Check name isn't already taken
  const existing = await sql<{ name: string }[]>`SELECT name FROM agents WHERE name = ${name}`;
  if (existing.length > 0) {
    throw new AgentError("name_taken", `Agent name "${name}" is already taken`);
  }

  // Insert agent row
  await sql`
    INSERT INTO agents (name, description, system_prompt, model, provider, status, prompt_generated_at, prompt_gen_model)
    VALUES (${name}, ${input.description.trim()}, ${systemPrompt}, ${model}, ${provider}, 'created',
            ${gen ? new Date().toISOString() : null}, ${gen?.model ?? null})
  `;

  // Mint bootstrap + access tokens (store hashes only)
  const bootstrap = mintToken("bootstrap");
  const access = mintToken("access");

  await sql`
    INSERT INTO agent_tokens (agent_name, kind, token_hash, expires_at)
    VALUES
      (${name}, 'bootstrap', ${bootstrap.hash}, NULL),
      (${name}, 'access',    ${access.hash},    NULL)
  `;

  return {
    name,
    command: `agent --token ${bootstrap.raw}`,
    token: bootstrap.raw,
  };
}

/** Exchange a (reusable) bootstrap token for the agent's credential bundle. */
export async function bootstrapAgent(
  rawBootstrap: string,
  host: string
): Promise<BootstrapResult> {
  const hash = hashToken("bootstrap", rawBootstrap);

  // Find a valid bootstrap token (reusable — no used_at or expires_at check)
  const rows = await sql<{ agent_name: string; id: number }[]>`
    SELECT agent_name, id FROM agent_tokens
    WHERE kind = 'bootstrap' AND token_hash = ${hash}
  `;

  if (rows.length === 0) {
    throw new AgentError("invalid_token", "Bootstrap token is invalid or the agent has been deleted");
  }

  const { agent_name } = rows[0];

  // Fetch agent details
  const agents = await sql<{
    name: string; system_prompt: string; provider: string; model: string;
  }[]>`
    SELECT name, system_prompt, provider, model FROM agents WHERE name = ${agent_name}
  `;
  if (agents.length === 0) {
    throw new AgentError("not_found", "Agent not found");
  }
  const agent = agents[0];

  // Get provider key
  const apiKey = getProviderKey(agent.provider);
  if (!apiKey) {
    // Mark as provisioned but report the missing key
    await sql`UPDATE agents SET status = 'provisioned' WHERE name = ${agent_name}`;
    throw new AgentError(
      "missing_key",
      `No API key configured for provider "${agent.provider}". Set it in packages/server/.env.`
    );
  }

  // Mint a fresh access token (replaces prior ones for this agent)
  const newAccess = mintToken("access");
  // Invalidate old access tokens, insert the new one
  await sql`UPDATE agent_tokens SET expires_at = now() WHERE agent_name = ${agent_name} AND kind = 'access'`;
  await sql`
    INSERT INTO agent_tokens (agent_name, kind, token_hash, expires_at)
    VALUES (${agent_name}, 'access', ${newAccess.hash}, NULL)
  `;

  // Update status
  await sql`UPDATE agents SET status = 'provisioned' WHERE name = ${agent_name}`;

  return {
    name: agent.name,
    systemPrompt: agent.system_prompt,
    provider: agent.provider,
    model: agent.model,
    apiKey,
    accessToken: newAccess.raw,
    wsUrl: `ws://${host}/ws`,
  };
}

/** Validate an access token for a given agent name (used on WS join). */
export async function validateAccessToken(name: string, rawToken: string): Promise<boolean> {
  const hash = hashToken("access", rawToken);
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM agent_tokens
    WHERE agent_name = ${name} AND kind = 'access' AND token_hash = ${hash}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  return rows.length > 0;
}

/** Check whether a name belongs to a registered agent. */
export async function findAgent(name: string): Promise<AgentRow | null> {
  const rows = await sql<AgentRow[]>`SELECT * FROM agents WHERE name = ${name}`;
  return rows.length > 0 ? rows[0] : null;
}

/** Update an agent's status. */
export async function setStatus(name: string, status: AgentStatus): Promise<void> {
  await sql`UPDATE agents SET status = ${status} WHERE name = ${name}`;
}

/** List all registered agents (from the DB, not the online-clients map). */
export async function listAgents(): Promise<AgentRow[]> {
  return sql<AgentRow[]>`SELECT * FROM agents ORDER BY created_at DESC`;
}
