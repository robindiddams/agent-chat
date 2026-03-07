/**
 * Chat Agent Entrypoint
 *
 * Wires together:
 *   1. ChatHarness — WebSocket client for the chat server
 *   2. Chat tools — send_message, dm, list_agents
 *   3. Pi Agent — LLM-powered agent from pi-agent-core
 *
 * The agent connects to the chat server, joins, says hello,
 * then responds to @mentions and DMs.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple, getModel } from "@mariozechner/pi-ai";
import { ChatHarness } from "./harness";
import { createChatTools } from "./tools";
import { generateName } from "./names";

// ── Configuration (from env) ─────────────────────────

const name = process.env.AGENT_NAME || generateName();
const chatUrl = process.env.CHAT_URL || "ws://localhost:8080/ws";
const modelProvider = process.env.MODEL_PROVIDER || "anthropic";
const modelId = process.env.MODEL_ID || "claude-sonnet-4-5";

console.log(`Starting agent "${name}"...`);
console.log(`Chat server: ${chatUrl}`);
console.log(`Model: ${modelProvider}/${modelId}`);

// ── 1. Create harness (WebSocket client) ─────────────

const harness = new ChatHarness(chatUrl, name);

// ── 2. Create tools ──────────────────────────────────

const tools = createChatTools(harness);

// ── 3. Create Pi Agent ───────────────────────────────

const agent = new Agent({
  initialState: {
    systemPrompt: `You are "${name}", an AI agent participating in a group chat room.

You can communicate with humans and other AI agents using your tools:
- send_message: Post a message to the group chat (everyone sees it)
- dm: Send a private message to a specific user or agent
- list_agents: See who's currently online
- join_channel: Join a channel to receive background notifications
- read_channel: Read messages from a channel (silent — just for your awareness)
- send_channel_message: Post a message to a channel you've joined

You can also read and write code:
- read_file: Read a file's contents
- write_file: Write/create a file (creates parent dirs as needed)
- bash: Run shell commands (builds, tests, git, etc.)

When someone talks to you directly (via @mention or DM), respond helpfully.
You can collaborate with other agents by DMing them. Keep messages concise.

IMPORTANT — Channel behavior:
- Channel notifications like "[background] Activity in #design" are FYI only
- You do NOT need to respond to channel activity
- You can read_channel silently to stay informed without saying anything
- Only speak in a channel if you have something genuinely useful to add
- It's fine to ignore channel notifications entirely if you're busy or it's not relevant

Important: Messages you receive will be prefixed with who sent them, e.g.
"[DM from robin]: hello" or "[alice in chat]: @${name} can you help?"`,
    model: getModel(modelProvider, modelId),
    tools,
  },
  streamFn: streamSimple,
});

// ── 4. Wire agent to harness ─────────────────────────

harness.setAgent(agent);

// ── 5. Connect and join chat ─────────────────────────

await harness.connect();

// ── 6. Say hello ─────────────────────────────────────

harness.sendMessage(
  `Hello! I'm ${name}, an AI agent. DM me or @mention me and I'll help out.`
);

console.log(`${name} is online and ready.`);

// The process stays alive because the WebSocket connection is open.
// All message handling happens via WebSocket events in the harness.
