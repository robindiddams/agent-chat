/**
 * prompt-gen.ts — LLM-powered system-prompt generation for created agents.
 *
 * The server generates a PERSONA/role/behavior prompt from the user's
 * description via a fireworks LLM call. The agent's operational layer
 * (tool reference, channel behavior, history) is appended at runtime by
 * the agent binary — so the generated prompt must NOT list tools or
 * channel mechanics, and must NOT include the agent's name (injected
 * at runtime).
 *
 * Falls back to the description verbatim if no FIREWORKS_API_KEY is set
 * or the LLM call fails. Never throws.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { Model, UserMessage } from "@earendil-works/pi-ai";

// ── Constants ─────────────────────────────────────────

export const GEN_MODEL = {
  provider: "fireworks",
  model: "accounts/fireworks/models/glm-5p2",
};

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

// Dummy key used in tests — skip the real LLM call when this is detected.
const DUMMY_KEY = "test-dummy-key";

// ── buildGenPrompt (pure) ─────────────────────────────

/**
 * Assemble the meta-prompt sent to the LLM to generate an agent's system prompt.
 * Pure function — no I/O.
 */
export function buildGenPrompt(description: string): string {
  return `You are writing a system prompt for an AI agent that lives in a group chat with humans and other AI agents. It is reached via @mention or direct message (DM).

Guidelines for a good prompt:
- Write in second person ("You are…"). Be concrete about the agent's role, expertise, and goals.
- Specify tone and conciseness — chat messages should be short and skimmable.
- Describe what the agent should do proactively vs. only when asked.
- Do NOT list tools or channel mechanics — those are appended automatically at runtime.
- Do NOT include the agent's name — it is injected at runtime.
- Keep it focused: a few short paragraphs. No bullet spam.

The agent operates in a group chat where it can send messages and DMs to humans and other agents, join channels to monitor and post in them, and read/write files and run shell commands. It receives incoming messages prefixed with the sender's name (e.g. "[DM from robin]: hello" or "[alice in chat]: @you can you help?").

Desired agent:
"${description.trim()}"

Write the system prompt:`;
}

// ── generateSystemPrompt ──────────────────────────────

/**
 * Generate a system prompt via an LLM call.
 *
 * Returns `{ prompt, model }` on success, or `null` if no key is configured,
 * the key is a test dummy, or the LLM call fails. Never throws.
 */
export async function generateSystemPrompt(
  description: string
): Promise<{ prompt: string; model: string } | null> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) return null;
  if (apiKey === DUMMY_KEY) return null; // test guard — skip real call

  // Hand-build a Model for fireworks glm-5p2 (not in pi-ai's static catalog).
  const model: Model<"openai-completions"> = {
    id: GEN_MODEL.model,
    name: GEN_MODEL.model,
    api: "openai-completions",
    provider: "fireworks" as any,
    baseUrl: FIREWORKS_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };

  const userMessage: UserMessage = {
    role: "user",
    content: buildGenPrompt(description),
    timestamp: Date.now(),
  };

  try {
    const result = await completeSimple(model, {
      messages: [userMessage],
    }, { apiKey, maxTokens: 1024 });

    // Extract text from the assistant message content
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    if (!text) return null;

    return { prompt: text, model: GEN_MODEL.model };
  } catch (err) {
    // Log a short warning without secrets; fall back gracefully
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[prompt-gen] LLM call failed, falling back to description: ${msg.slice(0, 200)}`);
    return null;
  }
}
