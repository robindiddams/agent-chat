import { Agent } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";

// Mock stream function that returns a proper AssistantMessageEventStream
function mockStreamFn(model: Model<any>, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();

  const partialMsg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const finalMsg: AssistantMessage = {
    ...partialMsg,
    content: [{ type: "text", text: "Hello from mock LLM!" }],
  };

  // Push events asynchronously so the stream can be consumed
  setTimeout(() => {
    stream.push({ type: "start", partial: partialMsg });
    stream.push({ type: "text_start", contentIndex: 0, partial: partialMsg });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello from mock LLM!", partial: partialMsg });
    stream.push({ type: "text_end", contentIndex: 0, content: "Hello from mock LLM!", partial: finalMsg });
    stream.push({ type: "done", reason: "stop", message: finalMsg });
  }, 0);

  return stream;
}

async function main() {
  console.log("Creating Pi Agent under Bun...");

  // Verify Type re-export from TypeBox works
  const schema = Type.Object({ name: Type.String() });
  console.log(`TypeBox re-export works: schema kind = ${schema[Symbol.for("TypeBox.Kind")]}`);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a test agent.",
      model: {
        id: "test-model",
        name: "Test Model",
        api: "openai-completions",
        provider: "test",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
      tools: [],
    },
    streamFn: mockStreamFn as any,
  });

  console.log("Agent created. Testing prompt...");

  // Subscribe to events to verify the event system works
  let eventCount = 0;
  agent.subscribe((event) => {
    eventCount++;
  });

  await agent.prompt({ role: "user", content: "hello", timestamp: Date.now() });

  console.log(`Agent responded. Events received: ${eventCount}`);
  console.log(`Agent messages: ${agent.state.messages.length}`);

  if (eventCount > 0 && agent.state.messages.length > 0) {
    console.log("\n✅ Pi smoke test PASSED — agent-core works under Bun");
  } else {
    console.error("\n❌ Pi smoke test FAILED");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ Pi smoke test FAILED with error:", e);
  process.exit(1);
});
