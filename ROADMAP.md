# agent-chat — Roadmap

> Status: prototype working again on latest pi (`@earendil-works/pi-*` `^0.79.4`).
> This doc plans the path from prototype → shippable, OSS-able product.

## Vision

A "Slack for AI agents": a chat surface where humans spin up sandboxed,
LLM-powered agents on demand, drop them into channels, talk to them directly, or
delegate to a central coordinator agent that fans work out and reports back.

## Guiding constraints

- **Runtime: Bun** (Node fallback if a dep forces it).
- **No Python.** Rules out LiteLLM Proxy and other Python-only infra. Anything we
  adopt must be Node/TS or a language-agnostic binary/service.
- **Headed for open source** — keep config/secrets clean, no hardcoded keys, sane
  defaults, documented setup.
- **Sandboxed by default** — agents run in containers, not in the server process.

## Current state (baseline)

- `packages/server` — Bun WebSocket server + vanilla HTML/JS UI (`ui.html`).
  In-memory state + `chat-history.json` on disk.
- `packages/agent` — raw `Agent` from pi-agent-core over a WS harness. Launched
  manually with provider API key in env.
- Protocol: global chat, DMs, channels (see `protocol.ts`).

---

## MVP (the bird gets in the air)

Three pillars. Ship these and it's a real thing.

### 1. New UI (replace `ui.html`)

- Move off vanilla HTML/JS to a **vanilla React SPA** — client-side only, **no
  Next.js / server components / SSR**. Plain React + a bundler (Vite), built to
  static assets and served by the Bun server (separate Vite dev server in dev).
- The Vercel `ai` SDK chatbot helpers (`useChat`, `assistant-ui`) work fine in a
  client-only SPA — useful for the Quartermaster chat surface later — but we are
  **not** adopting the Next.js app-router parts of that ecosystem.
- **Kill the global chat room.** Interaction model becomes: channels + direct
  agent conversations (+ later, the Quartermaster).
- Major UX pass: channel list / sidebar, per-agent or per-channel conversation
  view, presence, message threading/streaming.
- Decision: bundler/tooling (Vite assumed), component/styling approach.

### 2. Create-agent flow (UI button → sandboxed container)

The headline feature. User clicks **"Add"**, the system builds and launches an
agent. Flow:

1. UI: "Add agent" → user types a **description** of what the agent should do.
2. Server: an LLM call **generates the system prompt** from the description
   (plus name, default model/provider).
3. Server **spins up a sandboxed agent container** by talking to the **Docker
   socket** (no shelling out to `docker` CLI if avoidable — use the Docker Engine
   API over the socket).
4. Container boots the agent, **connects back** to the server, and **receives its
   model/provider id + token** (transport TBD — over the WS join handshake, or a
   small HTTP/API call on startup). See "Credential handoff" below.
5. Agent runs as it does today (harness + tools) and appears in the UI.

Sub-tasks:
- **Build the agent Docker image** (`packages/agent` containerized; Bun base
  image; entrypoint reads config from env/handshake; no baked-in secrets).
- Server-side Docker orchestration module: **spawn containers via the Docker
  Engine API over the Unix socket** (no shelling out to `docker` CLI). Create/start/
  stop/remove, health/lifecycle, cleanup on disconnect. (Post-MVP: add UI pages
  for raw docker logs and container config per-agent.)
- System-prompt generation endpoint/tool (one LLM call; reuse pi-ai).
- "Add agent" UI flow + agent lifecycle controls (stop/restart/remove).

### 3. Database backend

- Replace `chat-history.json` + in-memory maps with a real DB for: chat/channel
  messages, channel metadata/membership, agent registry (name, description,
  system prompt, model/provider, container id, status), and later usage/keys.
- **Pick a DB — Postgres is the default candidate.** Decide on access layer
  (e.g. Drizzle ORM for TS-first migrations, or a thin query layer). Note Bun ships
  a native `Bun.sql` Postgres client.
- Migration story for OSS users (docker-compose with Postgres alongside).

### Credential handoff (part of MVP)

Agents do not ship with provider keys. The server is the credential authority and
hands each agent what it needs on boot.

- On agent boot/join, the server hands the agent its **model/provider id + a
  token** (and, later, a **base URL** to route LLM traffic through).
- pi makes the client side trivial: wrap `streamFn` around `streamSimple` with an
  overridden `model.baseUrl` + per-request `apiKey`/`headers`. No fork needed
  (providers already read `model.baseUrl`, `options.apiKey`, `options.headers`).
- Transport: **HTTP REST**. Container is created with a one-time token baked in
  (env or config). On boot the agent calls a REST endpoint with that token to
  exchange it for its provider key + model/provider id + an access token for the
  server (access token details TBD). The one-time token is then spent/invalidated.
- Key lifecycle: TBD.

**MVP definition of done:** modern component UI, no global chat, click-to-create
a sandboxed agent in a container that connects, **receives its creds from the
server**, and works — all state in Postgres.

---

## Next (post-MVP, ordered)

### 4. AI gateway (maybe)

> Parked — still chewing on this. Idea: route all agent LLM traffic through a
> self-hosted gateway on the server for per-agent keys, spend limits, routing,
> and observability. Revisit once the MVP credential handoff is in place; it
> would slot in behind the same handoff seam. (Constraint: no Python.)

### 5. Quartermaster (central coordinator agent) — fuzzy, likely last

- A server-resident chatbot agent ("Quartermaster" / "Maker") I talk to via a
  normal AI chat interface (Vercel AI SDK `useChat` surface from #1).
- Has a `create_agent` tool (drives the #2 flow programmatically) and can survey
  channels/agents to answer "what's the status on X?" by delegating and
  reporting back.
- Deliberately scoped last — interaction model and tool surface need to settle
  after the create-agent flow and channels UX exist.

---

## Open decisions (track these)

- UI: **vanilla React SPA** (Vite, no Next/SSR) — settled. Remaining: styling/
  component approach.
- Database: **Postgres + Bun.sql** (native Bun Postgres client, no ORM layer).
- Credential transport: **HTTP REST** — settled. One-time token → provider key +
  model id + server access token. Access token shape TBD.
- Container orchestration: **Docker Engine API over Unix socket** — settled.
  Logs/config UI pages deferred to post-MVP.
- Key lifecycle: TBD.

## Explicitly out of scope / deferred

- Global chat room (being removed in MVP).
- AI gateway / per-agent key minting (parked — see #4; revisit later).
- Any Python-based infra.
- Multi-tenant / auth hardening beyond what OSS launch needs (revisit pre-launch).
