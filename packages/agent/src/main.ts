/**
 * Chat Agent Entrypoint
 *
 * Bootstraps credentials from the server, connects via WebSocket, downloads
 * chat history, and starts the Pi Agent with the server-supplied system prompt
 * and model configuration.
 *
 * Usage:
 *   agent --token <bootstrap-token> [--server http://localhost:8080]
 *   agent --help
 *
 * The --token is the bootstrap token returned by POST /api/agents.
 * It is exchanged for a credential bundle containing the system prompt,
 * provider, model, API key, and a long-lived access token for WS auth.
 * The token is reusable — the agent can restart and re-bootstrap.
 */

import { parseArgs } from "node:util";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { ChatHarness } from "./harness";
import { createChatTools } from "./tools";
import { bootstrap, resolveModel } from "./bootstrap";
import type { StoredMessage } from "../../server/src/protocol";

// ── CLI parsing ───────────────────────────────────────

function printUsage(): void {
  console.log(`Usage: agent --token <token> [options]

Options:
  --token <token>     Bootstrap token from POST /api/agents (required, reusable)
  --server <url>      Server base URL (default: http://localhost:8080)
  --help              Show this help message

The token is exchanged for credentials (system prompt, model, API key)
and an access token. The agent connects via WebSocket using the access
token and downloads chat history before starting. The bootstrap token is
reusable, so the agent can restart and re-bootstrap.`);
}

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    server: { type: "string", default: "http://localhost:8080" },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.token) {
  console.error("Error: --token is required.\n");
  printUsage();
  process.exit(1);
}

const serverUrl = values.server!;

// ── 1. Bootstrap: exchange token for credentials ────

const bundle = await bootstrap(serverUrl, values.token);

console.log(`Bootstrap successful for agent "${bundle.name}".`);
console.log(`Provider: ${bundle.provider}/${bundle.model}`);
console.log(`WebSocket: ${bundle.wsUrl}`);

// ── 2. Build the model ───────────────────────────────

const model = resolveModel(bundle.provider, bundle.model, bundle.baseUrl);

// ── 3. Create harness + connect ──────────────────────

const harness = new ChatHarness(bundle.wsUrl, bundle.name, bundle.accessToken);
await harness.connect();

// ── 4. Fold history into the system prompt (priming) ─

const history = harness.getHistory();
const systemPrompt = buildSystemPrompt(bundle.name, bundle.systemPrompt, history);

// ── 5. Create tools ──────────────────────────────────

const tools = createChatTools(harness);

// ── 6. Create Pi Agent ───────────────────────────────

const agent = new Agent({
  initialState: {
    systemPrompt,
    model,
    tools,
  },
  streamFn: streamSimple,
  // Inject the server-supplied provider key.
  // pi-agent-core calls getApiKey(model.provider) on each turn and passes
  // the result as options.apiKey to streamSimple (agent-loop.js:188).
  getApiKey: async () => bundle.apiKey,
});

// ── 7. Wire agent to harness ─────────────────────────

harness.setAgent(agent);

// ── 8. Say hello ─────────────────────────────────────

harness.sendMessage(
  `Hello! I'm ${bundle.name}, an AI agent. DM me or @mention me and I'll help out.`
);

console.log(`${bundle.name} is online and ready.`);

// The process stays alive because the WebSocket connection is open.
// All message handling happens via WebSocket events in the harness.

// ── Helpers ───────────────────────────────────────────

/**
 * Build the full system prompt: server-generated persona + operational layer
 * (tool reference, channel behavior) + recent chat history as a priming block.
 *
 * The persona is generated server-side via an LLM call and passed in as
 * `serverPrompt`. This function appends the fixed operational instructions
 * (tools, channel behavior) and a recent-history transcript.
 */
function buildSystemPrompt(
  name: string,
  serverPrompt: string,
  history: StoredMessage[]
): string {
  const operational = `You are an AI agent participating in a group chat room with humans and other AI agents. You are reached via @mention or direct message (DM).

You communicate ONLY by calling tools — there is no other way to send messages. Never respond with plain text; if you want to reply, you MUST call a tool.

Chat tools:
- send_message: Post a message to the group chat (everyone sees it)
- dm: Send a private message to a specific user or agent (use this to reply to a DM)
- list_agents: See who's currently online
- join_channel: Join a channel to receive background notifications
- read_channel: Read messages from a channel (silent — just for your awareness)
- send_channel_message: Post a message to a channel you've joined

You can also read and write code:
- read_file: Read a file's contents
- write_file: Write/create a file (creates parent dirs as needed)
- bash: Run shell commands (builds, tests, git, etc.)

When someone @mentions or DMs you, reply by calling the dm tool (for a DM) or send_message (for an @mention). Respond helpfully and keep messages concise.

IMPORTANT — Channel behavior:
- Channel notifications like "[background] Activity in #design" are FYI only
- You do NOT need to respond to channel activity
- You can read_channel silently to stay informed without saying anything
- Only speak in a channel if you have something genuinely useful to add
- It's fine to ignore channel notifications entirely if you're busy or it's not relevant

Important: Messages you receive will be prefixed with who sent them, e.g.
"[DM from robin]: hello" or "[alice in chat]: @${name} can you help?"`;

  const preamble = `${serverPrompt}

${operational}`;

  // Append recent history as a priming context block (lossy, last 50 messages)
  const recent = history.slice(-50);
  if (recent.length === 0) {
    return preamble;
  }

  const transcript = recent
    .map((m) => {
      const time = new Date(m.time).toLocaleString();
      if (m.type === "dm") {
        return `[${time}] DM ${m.from} → ${m.to}: ${m.text}`;
      }
      if (m.type === "channel_message") {
        return `[${time}] #${m.channel} ${m.from}: ${m.text}`;
      }
      return `[${time}] ${m.from}: ${m.text}`;
    })
    .join("\n");

  return `${preamble}

--- Recent conversation history (for context) ---
${transcript}
--- End of history ---`;
}
