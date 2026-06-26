# agent-chat — Task List

> Credential handoff + create-agent flow. Docker deferred — the seam is built so
> Docker slots in later behind the same bootstrap exchange.

## Locked decisions
- **Server is the credential authority.** Provider keys live in `packages/server/.env`. Server generates the system prompt + picks the model and passes `{systemPrompt, provider, model, apiKey}` down at bootstrap.
- **System-prompt generation: STUB for now** (description used verbatim). Real LLM call is the next task after this lands.
- **Agent ships as a compiled binary** (`bun build --compile` → `dist/agent`). Create endpoint returns `agent --token <X>`.
- **Token:** 96-bit random base64url (16 chars, no padding). Two kinds: `bootstrap` (one-time, 1h TTL) and `access` (long-lived, rotatable).
- **Hash:** `Bun.hash` (wyhash, 64-bit) → 16 hex chars. Non-cryptographic; fine on a tailnet at our scale. Swap to crypto if threat model changes.
- **History download:** agent ingests recent history as a priming context block (lossy, simple).
- **No human auth.** Runs over Tailscale; only registered agent-names require a token on WS join.
- **Kill mechanism:** `POST /api/agents/:name/stop` → server sends `{type:"shutdown"}` over the agent's live WS → agent exits → status updated. (Authoritative kill comes with Docker later.)

## Phase A — server: credential authority + registry
- [ ] A1. Migration `db/002_agent_tokens.sql` (+ apply via `db:migrate`)
- [ ] A2. `src/tokens.ts` — mint (12-byte base64url) + wyhash-64 hex
- [ ] A3. `src/credentials.ts` — `getProviderKey(provider)` from `.env` (small provider→env map, no new deps)
- [ ] A4. `src/agents.ts` — `createAgent` / `bootstrapAgent` / `validateAccessToken` / `setStatus` + stubbed prompt-gen
- [ ] A5. `src/server.ts` — `POST /api/agents`, `POST /api/agents/bootstrap`, `GET /api/agents`, `POST /api/agents/:name/stop`; WS join token check (only for registered agent names) + status; `{type:"shutdown"}` message
- [ ] A6. Add provider key(s) to `packages/server/.env` (fireworks/glm to match today)

## Phase B — agent: binary + bootstrap
- [ ] B1. `src/bootstrap.ts` — HTTP exchange + `resolveModel(provider, model)` (`getModel` if known, else hand-built `Model`)
- [ ] B2. `src/main.ts` — `parseArgs --token/--server`, bootstrap, inject `getApiKey`, set model
- [ ] B3. `src/harness.ts` — send token in `join`; consume `history` → priming block; handle `shutdown` → graceful exit
- [ ] B4. `package.json` — `build: bun build src/main.ts --compile --outfile dist/agent`

## Phase C — verify + document
- [ ] C1. e2e: create → bootstrap (assert one-time) → WS join w/ access token → history received → `stop` kills it; self-cleaning
- [ ] C2. README: creds flow, building the binary, `.env` provider keys, Tailscale/TLS + non-crypto-hash note

## Next task (after this lands)
- Real LLM system-prompt generation (`prompt-gen.ts`).

## Later
- Docker-managed lifecycle behind the same bootstrap seam.
