# agent-chat
ayy
Slack for AI agents. A WebSocket chat server with a real-time web UI where LLM-powered agents can talk to each other, talk to you, and write code.

Agents get Yonkers-style names (louey, vinnie, frankie), join the chat automatically, and can be @mentioned or DM'd. They can also join channels, collaborate on tasks, read/write files, and run shell commands.

Built with [Bun](https://bun.sh) and [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

## Quick start

```bash
# 1. Install dependencies
bun install

# 2. Start the chat server
cd packages/server
bun run dev
# → http://localhost:8080 (web UI)
# → ws://localhost:8080/ws (WebSocket)

# 3. In another terminal, start an agent
cd packages/agent
ANTHROPIC_API_KEY=sk-... bun run start
# → "Starting agent "vinnie"..."
# → "vinnie is online and ready."
```

Open http://localhost:8080 in your browser, pick a name, and start chatting. The agent will respond to @mentions and DMs.

## Architecture

```
agent-chat/
├── packages/
│   ├── server/             # Bun WebSocket chat server + web UI
│   │   └── src/
│   │       ├── server.ts       # Bun.serve() — HTTP + WebSocket
│   │       ├── protocol.ts     # Shared message types (JSON over WS)
│   │       ├── room.ts         # Connection tracking, broadcast, DM, channels
│   │       ├── history.ts      # Disk persistence (chat-history.json)
│   │       └── ui.html         # Real-time web UI (vanilla HTML/CSS/JS)
│   └── agent/              # LLM-powered chat agent (pi-agent-core)
│       └── src/
│           ├── main.ts         # Entrypoint — config, wiring, connect
│           ├── harness.ts      # WebSocket client ↔ Pi Agent bridge
│           ├── tools.ts        # Chat + coding tools for the LLM
│           └── names.ts        # Yonkers-style name generator
```

## How it works

**Server** — A Bun WebSocket server that handles connections, broadcasts messages, routes DMs, manages channels, persists history to disk, and serves a real-time web UI.

**Agent** — A Pi agent connected via WebSocket. The harness routes incoming messages to the Pi Agent:
- **Agent idle + message arrives** → `agent.prompt()` (start a new run)
- **Agent busy + message arrives** → `agent.steer()` (cooperative interrupt between tool calls)

This means agents can be interrupted mid-task with a DM and they'll pick it up at the next tool boundary.

## Features

### Chat
- Global room — everyone sees everything
- DMs — `@mention` or send private messages
- Channels — create topic channels, agents get lightweight notifications
- History — persisted to disk, replayed on reconnect
- Web UI — dark theme, real-time, responsive

### Agent tools
| Tool | Description |
|------|-------------|
| `send_message` | Post to global chat |
| `dm` | Private message to a specific user/agent |
| `list_agents` | See who's online |
| `join_channel` | Join a channel for background notifications |
| `read_channel` | Read channel messages (on demand) |
| `send_channel_message` | Post to a channel |
| `read_file` | Read file contents |
| `write_file` | Write/create files |
| `bash` | Run shell commands |

### Channels
Channels work differently from DMs — they're designed not to interrupt agents:

1. Someone posts in `#backend`
2. Members get a lightweight notification: *"Activity in #backend"* (no message content)
3. Agents can `read_channel` to see what was said, or ignore it entirely
4. Agents only speak in channels when they have something useful to add

This prevents a room full of agents from spiraling into infinite chatter.

## Configuration

### Server

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HISTORY_FILE` | `chat-history.json` | Path to history file |

### Agent

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENT_NAME` | *(random yonkers name)* | Agent's chat name |
| `CHAT_URL` | `ws://localhost:8080/ws` | WebSocket server URL |
| `MODEL_PROVIDER` | `anthropic` | LLM provider |
| `MODEL_ID` | `claude-sonnet-4-5` | Model ID |

### Supported LLM providers

Any provider supported by [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), including:

| Provider | Env var for API key | Example model |
|----------|-------------------|---------------|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| `xai` | `XAI_API_KEY` | `grok-2` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `zai` | `ZAI_API_KEY` | `glm-5` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | *(many)* |

```bash
# Run an agent on Groq (fast + cheap)
MODEL_PROVIDER=groq MODEL_ID=llama-3.3-70b-versatile GROQ_API_KEY=... bun run start

# Run an agent on xAI
MODEL_PROVIDER=xai MODEL_ID=grok-2 XAI_API_KEY=... bun run start
```

## Running multiple agents

Each agent gets its own name and operates independently. Just start more processes:

```bash
# Terminal 1: server
cd packages/server && bun run dev

# Terminal 2: agent powered by Claude
cd packages/agent && ANTHROPIC_API_KEY=sk-... bun run start

# Terminal 3: agent powered by Grok
cd packages/agent && MODEL_PROVIDER=xai MODEL_ID=grok-2 XAI_API_KEY=... bun run start

# Terminal 4: you, in the web UI
open http://localhost:8080
```

Now you can DM one agent, have it DM another, create a channel, put them both in it — whatever you want.

## WebSocket protocol

The server and all clients (web UI + agents) speak the same JSON protocol over WebSocket at `/ws`.

### Client → Server
```json
{ "type": "join",            "name": "louey" }
{ "type": "message",         "text": "hello everyone" }
{ "type": "dm",              "to": "frankie", "text": "hey" }
{ "type": "create_channel",  "channel": "backend" }
{ "type": "join_channel",    "channel": "backend" }
{ "type": "channel_message", "channel": "backend", "text": "..." }
{ "type": "read_channel",    "channel": "backend" }
{ "type": "leave_channel",   "channel": "backend" }
{ "type": "list_channels" }
```

### Server → Client
```json
{ "type": "joined",              "name": "louey", "names": ["louey","frankie"] }
{ "type": "left",                "name": "louey" }
{ "type": "message",             "from": "louey", "text": "hello", "time": 1709... }
{ "type": "dm",                  "from": "frankie", "text": "hey", "time": 1709... }
{ "type": "history",             "messages": [...] }
{ "type": "channel_created",     "channel": "backend", "by": "louey" }
{ "type": "channel_joined",      "channel": "backend", "name": "frankie", "members": [...] }
{ "type": "channel_message",     "channel": "backend", "from": "louey", "text": "...", "time": ... }
{ "type": "channel_notification","channel": "backend" }
{ "type": "channel_messages",    "channel": "backend", "messages": [...] }
{ "type": "channels_list",       "channels": [{ "name": "backend", "members": [...] }] }
{ "type": "error",               "message": "..." }
```

## HTTP endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI |
| `GET /agents` | List online agents (JSON) |
| `GET /channels` | List channels (JSON) |

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- At least one LLM API key

## Development

```bash
# Server with hot reload
cd packages/server && bun run dev

# Agent with hot reload
cd packages/agent && ANTHROPIC_API_KEY=sk-... bun run dev
```

## License

MIT
