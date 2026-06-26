import { describe, test, expect, afterEach } from "bun:test";
import { buildGenPrompt, generateSystemPrompt, GEN_MODEL } from "./prompt-gen";

// ── Helpers ───────────────────────────────────────────

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.FIREWORKS_API_KEY;

function restoreEnv() {
  if (ORIG_KEY === undefined) delete process.env.FIREWORKS_API_KEY;
  else process.env.FIREWORKS_API_KEY = ORIG_KEY;
  globalThis.fetch = ORIG_FETCH;
}

afterEach(restoreEnv);

// ── Tests ─────────────────────────────────────────────

describe("prompt-gen: buildGenPrompt", () => {
  test("includes the tech-doc guidelines, the basis, and the description", () => {
    const desc = "a concise agent that summarizes channel activity";
    const p = buildGenPrompt(desc);

    // Tech-doc guidelines
    expect(p).toContain("second person");
    expect(p).toContain("Do NOT list tools");
    expect(p).toContain("Do NOT include the agent's name");

    // Operational basis (paraphrased capabilities)
    expect(p).toContain("group chat");
    expect(p).toContain("channel");
    expect(p).toContain("shell commands");

    // The user's description, delimited
    expect(p).toContain(desc);
    expect(p).toContain("Desired agent:");

    // Must NOT include the tool reference list (that's the operational layer)
    expect(p).not.toContain("send_message");
    expect(p).not.toContain("read_file");
  });
});

describe("prompt-gen: generateSystemPrompt", () => {
  test("returns null when no FIREWORKS_API_KEY is set", async () => {
    delete process.env.FIREWORKS_API_KEY;
    const result = await generateSystemPrompt("a helpful agent");
    expect(result).toBeNull();
  });

  test("returns null when key is the test dummy guard", async () => {
    process.env.FIREWORKS_API_KEY = "test-dummy-key";
    const result = await generateSystemPrompt("a helpful agent");
    expect(result).toBeNull();
  });

  test("returns {prompt, model} with a mocked fetch (happy path)", async () => {
    process.env.FIREWORKS_API_KEY = "real-key-for-testing";

    // pi-ai uses the OpenAI SDK which streams via SSE. Mock fetch to return
    // a Response with a ReadableStream body emitting SSE-formatted chunks.
    const generatedText = "You are a concise summarization agent. You distill channel activity into clear, brief updates. Keep messages short and actionable. Proactively summarize when conversations wrap up.";
    const encoder = new TextEncoder();

    // Split into two content chunks + a stop chunk (realistic streaming)
    const mid = Math.floor(generatedText.length / 2);
    const sseChunks = [
      { id: "chatcmpl-fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: generatedText.slice(0, mid) }, finish_reason: null }] },
      { id: "chatcmpl-fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: generatedText.slice(mid) }, finish_reason: null }] },
      { id: "chatcmpl-fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    ];

    const body = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const fakeResponse = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    globalThis.fetch = (() => Promise.resolve(fakeResponse)) as typeof fetch;

    const result = await generateSystemPrompt("a concise agent that summarizes channel activity");

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("concise summarization agent");
    expect(result!.prompt.length).toBeGreaterThan(20);
    expect(result!.model).toBe(GEN_MODEL.model);
  });

  test("returns null when the LLM call throws (graceful fallback)", async () => {
    process.env.FIREWORKS_API_KEY = "real-key-for-testing";
    globalThis.fetch = (() => Promise.reject(new Error("network error"))) as typeof fetch;

    const result = await generateSystemPrompt("a helpful agent");
    expect(result).toBeNull();
  });
});
