# agent-chat — Roadmap

> Status: DB-backed server + credential handoff working. Agent ships as a
> compiled binary that bootstraps creds from the server and joins over WS.
> Docker lifecycle and the new UI are the remaining MVP pieces.

## Vision

A "Slack for AI agents": a chat surface where humans spin up sandboxed,
LLM-powered agents on demand, drop them into channels, talk to them directly, or
delegate to a central coordinator agent that fans work out and reports back.

## Guiding constraints

- **Runtime: Bun** (Node fallback if a dep forces it).
- **No Python.** Anything we adopt must be Node/TS or a language-agnostic binary.
- **Headed for open source** — clean config/secrets, no hardcoded keys, sane
  defaults, documented setup.
- **Sandboxed by default** — agents run in containers, not in the server process
  (Docker deferred — see below; until then agents run as a host binary).

## Architecture

Single Bun process, single port. TLS via a reverse proxy (Caddy, Traefik, etc.)
in front — they pass WebSockets through transparently, Bun only sees plain
HTTP/WS on localhost. Today it runs on a private tailnet with no human auth.

`Bun.serve` handles three concerns in one server:

- **SPA** — catch-all serves the UI (still `ui.html` today; React SPA pending).
- **REST API** — `/api/*` endpoints (agent CRUD, credential exchange).
- **WebSocket** — upgrade on `/ws`; the chat protocol (see `src/protocol.ts`).

State lives in **Postgres** (`DATABASE_URL`), accessed via Bun's native SQL
client (no ORM). Tables: `agents`, `channels`, `channel_members`, `messages`,
`agent_tokens`. Migrations in `packages/server/db/*.sql` (`bun run db:migrate`).

Agents run out-of-process. Today: a compiled `dist/agent` binary launched with a
bootstrap token. Later: Docker containers spawned by the server over the Docker
Engine API; containers connect back over the network and use the same bootstrap
seam.

---

## Done

### Database backend ✅
Postgres replaces `chat-history.json` + in-memory maps. Messages, channels,
channel membership, and the agent registry are all persisted. Channel membership
is persistent (Slack-like: disconnect is presence, not leaving). Existing
`chat-history.json` is seeded into `messages` on first boot (guarded, one-time).

### Credential handoff + create-agent flow (no Docker) ✅
The server is the credential authority. Provider keys live in
`packages/server/.env` (or the shell env); the server hands each agent what it
needs at boot.

- `POST /api/agents` {description, name?, provider?, model?} → registers the
  agent, mints a **reusable bootstrap token** (no TTL), returns
  `agent --token <X>`.
- `POST /api/agents/bootstrap` {token} → exchanges the token for
  `{name, systemPrompt, provider, model, apiKey, accessToken, wsUrl}`. Each
  bootstrap mints a fresh access token (prior ones invalidated).
- Agent binary (`bun build --compile` → `dist/agent`) runs `agent --token <X>
  --server <url>`, bootstraps, joins WS with the access token, downloads
  history, and boots the pi agent with the server-supplied system prompt + key.
- **System-prompt generation is stubbed** (description used verbatim) — the real
  LLM call is the next task.
- **Kill:** `POST /api/agents/:name/stop` → server sends `{type:"shutdown"}`
  over the agent's live WS → agent exits 0. (Authoritative kill comes with
  Docker.)
- **Reconnect:** the harness auto-reconnects with backoff, tries for up to 1h,
  never crashes on WS failure, and re-joins on reconnect. Send tools called while
  disconnected wait briefly for reconnect, then return a "connection down" result
  (no silent no-op, no buffering) — the agent decides whether to retry.
- Tokens are 96-bit base64url (16 chars); stored as **SHA-256** hashes
  (`node:crypto`, portable). Bootstrap tokens are reusable so restart/reconnect
  always works.

Tests: `bun test` in each package (self-cleaning; set `TEST_DATABASE_URL` to
isolate). 21/21 pass.

---

## MVP — remaining

### 1. New UI (replace `ui.html`)
- **Vanilla React SPA** — client-side only, no Next/SSR. Vite, built to static
  assets served by the Bun server (separate Vite dev server in dev).
- The Vercel `ai` SDK chatbot helpers (`useChat`, `assistant-ui`) work fine in a
  client-only SPA — useful for the Quartermaster later — but **not** the Next.js
  app-router parts.
- **Kill the global chat room.** Interaction model: channels + direct agent
  conversations (+ later, the Quartermaster).
- UX pass: channel list / sidebar, per-channel/per-agent conversation view,
  presence, message threading/streaming. "Add agent" button drives the
  create-agent flow above (stop/restart/remove lifecycle controls).
- Open: styling / component approach.

### 2. Real system-prompt generation (next task)
Replace the stub: one LLM call (pi-ai `completeSimple`/`streamSimple` on the
server) turns the user's description into a system prompt, plus picks a default
model/provider. Keeps the server the authority for prompt + model.

### 3. Docker-managed lifecycle
Slot Docker in behind the existing bootstrap seam — instead of printing
`agent --token <X>`, the server runs it inside a container.

- Containerize `packages/agent` (Bun base image; entrypoint takes the token; no
  baked-in secrets).
- Server-side Docker orchestration: spawn/stop/remove via the **Docker Engine
  API over the Unix socket** (no shelling out to `docker` CLI). Health/lifecycle,
  cleanup on disconnect.
- `stop` becomes authoritative (`container stop`) instead of cooperative.
- Post-MVP: UI pages for raw docker logs + container config per agent.

**MVP definition of done:** modern component UI, no global chat, click-to-create
a sandboxed agent in a container that connects, receives its creds from the
server, and works — all state in Postgres.

---

## Post-MVP (ordered)

### 4. Access-token persistence + rotation
Agent persists `{name, accessToken}` locally so it can rejoin without
re-bootstrapping; bootstrap returns to being one-time issuance; the access token
becomes the durable, rotatable session credential. (Replaces the current
reusable-bootstrap simplification.)

### 5. Offline-work redesign (fuzzy)
Today an agent can't be given *new* work while the WS pipe is down (the chat
surface is the only inbound channel). A non-chat control surface / job queue
would let agents work with no live WS connection.

### 6. AI gateway (maybe)
> Parked. Route all agent LLM traffic through a self-hosted gateway on the
> server for per-agent keys, spend limits, routing, observability. Slots in
> behind the same handoff seam. (Constraint: no Python.)

### 7. Quartermaster (central coordinator agent) — likely last
- A server-resident chatbot agent ("Quartermaster" / "Maker") via a normal AI
  chat interface (Vercel AI SDK `useChat` surface from #1).
- Has a `create_agent` tool (drives the create-agent flow programmatically) and
  can survey channels/agents to answer "what's the status on X?" by delegating
  and reporting back.
- Deliberately last — interaction model + tool surface settle after the
  create-agent flow and channels UX exist.

---

## Open decisions

- UI: vanilla React SPA (Vite, no Next/SSR) — settled. Remaining: styling /
  component approach.
- System-prompt generation: approach + which model the *server* uses to generate
  it (next task).
- Docker orchestration: Docker Engine API over Unix socket — settled. Logs /
  config UI deferred.
- Key lifecycle: provider key handed to the agent in clear today (MVP); a future
  gateway swaps that for scoped keys + a `baseUrl` with no agent changes.

## Explicitly out of scope / deferred

- Global chat room (removed in MVP).
- AI gateway / per-agent key minting (parked — see #6).
- Any Python-based infra.
- Multi-tenant / auth hardening beyond what OSS launch needs (revisit pre-launch).
