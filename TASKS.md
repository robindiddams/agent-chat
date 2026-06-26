# agent-chat — Task List

> Credential handoff + create-agent flow. Docker deferred — the seam is built so
> Docker slots in later behind the same bootstrap exchange.

## Locked decisions
- **Server is the credential authority.** Provider keys live in `packages/server/.env`. Server generates the system prompt + picks the model and passes `{systemPrompt, provider, model, apiKey}` down at bootstrap.
- **System-prompt generation: STUB for now** (description used verbatim). Real LLM call is the next task after this lands.
- **Agent ships as a compiled binary** (`bun build --compile` → `dist/agent`). Create endpoint returns `agent --token <X>`.
- **Token:** 96-bit random base64url (16 chars, no padding).
- **Bootstrap token: REUSABLE, no TTL, no one-time** — valid until the agent is deleted. Restart/reconnect re-bootstraps. (Reverted from the one-time+1h TTL design so reconnect always works.)
- **Access token:** minted at bootstrap, used for WS join identity bind. Currently lives only in memory.
- **Hash:** SHA-256 via `node:crypto` → 64 lowercase hex chars. Portable (Bun/Node/Deno/other langs).
- **History download:** agent ingests recent history as a priming context block (lossy, simple).
- **No human auth.** Runs over Tailscale; only registered agent-names require a token on WS join.
- **Kill mechanism:** `POST /api/agents/:name/stop` → server sends `{type:"shutdown"}` over the agent's live WS → agent exits → status updated. (Authoritative kill comes with Docker later.)

## Phase A — server: credential authority + registry  ✅ DONE (11/11 tests pass)
- [x] A1. Migration `db/002_agent_tokens.sql` (+ applied)
- [x] A2. `src/tokens.ts` — mint (12-byte base64url) + wyhash-64 hex
- [x] A3. `src/credentials.ts` — `getProviderKey(provider)` from `.env`
- [x] A4. `src/agents.ts` — `createAgent` / `bootstrapAgent` / `validateAccessToken` / `setStatus` / list/find + stubbed prompt-gen
- [x] A5. `src/server.ts` — `/api/agents` (+bootstrap, +:name/stop), GET registry; WS join token check for registered agents; `{type:"shutdown"}`
- [x] A6. Provider key is runtime config, not a task — `credentials.ts` reads `process.env`; populate `FIREWORKS_API_KEY` via shell export or `packages/server/.env` (gitignored). No code change.

## Phase B — agent: binary + bootstrap
- [x] B1. `src/bootstrap.ts` — HTTP exchange + `resolveModel(provider, model)` (`getModel` if known, else hand-built `Model`)
- [x] B2. `src/main.ts` — `parseArgs --token/--server`, bootstrap, inject `getApiKey`, set model
- [x] B3. `src/harness.ts` — send token in `join`; consume `history` → priming block; handle `shutdown` → graceful exit
- [x] B4. `package.json` — `build: bun build src/main.ts --compile --outfile dist/agent`

## Phase B2 — reconnect resilience  ✅ DONE (21/21 tests pass + live verified)
- [x] B2a. **Server:** bootstrap token is reusable (no TTL, no one-time); `used_at`/`expires_at` no longer set for bootstrap rows; each bootstrap still mints a fresh access token.
- [x] B2b. **Harness:** WS auto-reconnect with backoff (1s→2s→5s→10s cap), tries for up to 1h (`RECONNECT_TIMEOUT_MS`), never crashes on WS failure, re-joins on reconnect.
- [x] B2c. **Tools while disconnected:** send tools wait up to 30s (tunable via `AGENT_TOOL_WAIT_MS`) for reconnection, then return a "connection down" result — no silent no-op, no buffering.
- [x] B2d. Tests: reconnect e2e (server kill→restart→agent rejoins), tool-while-down unit test, all self-cleaning.

## Phase C — verify + document
- [ ] C1. e2e: create → bootstrap → WS join w/ access token → history received → `stop` kills it; self-cleaning (covered by agents.test.ts + reconnect.test.ts)
- [ ] C2. README: creds flow, building the binary, `.env` provider keys, Tailscale/TLS + non-crypto-hash note

## Next task (after this lands)
- Real LLM system-prompt generation (`prompt-gen.ts`).

## Later
- Access-token persistence + rotation (agent persists `{name, accessToken}` locally; bootstrap returns to being one-time issuance; access token is the durable session credential, rotatable).
- Deeper "work while offline" redesign: non-chat control surface / job queue so an agent can be given work with no WS pipe.
- Docker-managed lifecycle behind the same bootstrap seam.
