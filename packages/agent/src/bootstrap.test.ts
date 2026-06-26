/**
 * bootstrap.test.ts — Tests the agent's bootstrap + model resolution.
 *
 * Boots the SERVER as a child process (same pattern as packages/server/src/e2e.test.ts),
 * creates an agent via POST /api/agents, calls bootstrap() to exchange the token,
 * asserts the credential bundle is correct, and verifies the one-time semantics.
 *
 * DB URL: TEST_DATABASE_URL || DATABASE_URL (swappable).
 * A dummy FIREWORKS_API_KEY is injected so bootstrap succeeds.
 * Self-cleaning — never logs secrets.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { bootstrap, resolveModel } from "./bootstrap";

// ── Config ───────────────────────────────────────────────────────────────

// Try env first, then fall back to packages/server/.env (Bun only auto-loads
// .env from cwd, and this test runs from packages/agent).
let DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const envPath = resolve(import.meta.dir, "../../server/.env");
    const envText = readFileSync(envPath, "utf-8");
    const match = envText.match(/^DATABASE_URL\s*=\s*(.+)$/m);
    if (match) DB_URL = match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    // .env not found or no DATABASE_URL in it
  }
}
if (!DB_URL) {
  throw new Error(
    "Neither TEST_DATABASE_URL nor DATABASE_URL is set. " +
      "Set one in packages/server/.env or the environment."
  );
}

const testSql = new SQL(DB_URL);

const RUN_ID = Date.now();
const AGENT_NAME = `e2e-agent-${RUN_ID}`;
const AGENT_DESC = `e2e bootstrap test agent ${RUN_ID}`;

// ── Server child process ──────────────────────────────────────────────────

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let testPort = 0;

function getFreePort(): number {
  const temp = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = temp.port;
  temp.stop(true);
  return port;
}

async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) {
        await new Promise((r) => setTimeout(r, 500));
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

// ── Pre/post counts ───────────────────────────────────────────────────────

let preAgentCount = 0;
let preTokenCount = 0;

describe("agent bootstrap: credential exchange + model resolution", () => {
  beforeAll(async () => {
    const [agentRow] = await testSql`SELECT count(*)::int AS n FROM agents`;
    preAgentCount = agentRow.n;
    const [tokenRow] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    preTokenCount = tokenRow.n;

    testPort = getFreePort();
    const serverPath = import.meta.dir + "/../../server/src/server.ts";
    const cwd = import.meta.dir + "/../..";

    serverProc = Bun.spawn({
      cmd: ["bun", "run", serverPath],
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        PORT: String(testPort),
        FIREWORKS_API_KEY: "test-dummy-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForServer(testPort);
  }, 15_000);

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill();
      try { await serverProc.exited; } catch {}
    }

    // Cleanup: delete the test agent (cascades to agent_tokens).
    await testSql`DELETE FROM agents WHERE name = ${AGENT_NAME}`;

    // Verify pre-existing data is intact.
    const [agentRow] = await testSql`SELECT count(*)::int AS n FROM agents`;
    const [tokenRow] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    expect(agentRow.n).toBe(preAgentCount);
    expect(tokenRow.n).toBe(preTokenCount);

    await testSql.close();
  });

  // ── 1. bootstrap() exchanges token for credentials ──────────────────────

  test("bootstrap() exchanges token for a credential bundle", async () => {
    // Create an agent on the server
    const createRes = await fetch(`http://localhost:${testPort}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: AGENT_DESC, name: AGENT_NAME }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.token).toBeDefined();

    // Exchange the token via bootstrap()
    const bundle = await bootstrap(`http://localhost:${testPort}`, created.token);

    expect(bundle.name).toBe(AGENT_NAME);
    expect(bundle.systemPrompt).toBe(AGENT_DESC); // stub: description = system prompt
    expect(bundle.provider).toBe("fireworks");
    expect(bundle.model).toBe("accounts/fireworks/models/glm-5p1");
    expect(bundle.apiKey).toBe("test-dummy-key");
    expect(bundle.accessToken).toBeDefined();
    expect(bundle.accessToken.length).toBe(16); // 12 bytes base64url = 16 chars
    expect(bundle.wsUrl).toBe(`ws://localhost:${testPort}/ws`);
  });

  // ── 2. bootstrap() can be reused (token is not one-time) ────────────

  test("bootstrap() allows reusing the same token (reusable, not one-time)", async () => {
    // Create a fresh agent
    const reuseAgentName = `e2e-reuse-${RUN_ID}`;
    try {
      const createRes = await fetch(`http://localhost:${testPort}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "reuse test", name: reuseAgentName }),
      });
      const created = await createRes.json();

      // First bootstrap — succeeds
      const bundle = await bootstrap(`http://localhost:${testPort}`, created.token);
      expect(bundle.name).toBe(reuseAgentName);
      const firstAccessToken = bundle.accessToken;

      // Second bootstrap with the SAME token — should also succeed (reusable)
      const bundle2 = await bootstrap(`http://localhost:${testPort}`, created.token);
      expect(bundle2.name).toBe(reuseAgentName);
      // Each bootstrap mints a fresh access token
      expect(bundle2.accessToken).not.toBe(firstAccessToken);
    } finally {
      await testSql`DELETE FROM agents WHERE name = ${reuseAgentName}`;
    }
  });

  // ── 3. bootstrap() rejects a bogus token ────────────────────────────────

  test("bootstrap() rejects a bogus token", async () => {
    await expect(
      bootstrap(`http://localhost:${testPort}`, "totally-bogus-token")
    ).rejects.toThrow(/401|invalid|expired/i);
  });

  // ── 4. resolveModel() resolves a known provider/model ───────────────────

  test("resolveModel() resolves fireworks/glm via getModel catalog", () => {
    const model = resolveModel("fireworks", "accounts/fireworks/models/glm-5p1");
    expect(model.id).toBe("accounts/fireworks/models/glm-5p1");
    expect(model.provider).toBe("fireworks");
    expect(model.baseUrl).toBeTruthy();
  });

  // ── 5. resolveModel() falls back for unknown OpenAI-compatible providers ─

  test("resolveModel() hand-builds for unknown OpenAI-compatible providers", () => {
    const model = resolveModel("groq", "llama-3.3-70b-versatile");
    expect(model.id).toBe("llama-3.3-70b-versatile");
    expect(model.provider).toBe("groq");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.groq.com/openai/v1");
  });

  // ── 6. resolveModel() respects baseUrl override ─────────────────────────

  test("resolveModel() respects baseUrl override for future gateway", () => {
    const model = resolveModel("fireworks", "accounts/fireworks/models/glm-5p1", "https://gateway.local/v1");
    expect(model.baseUrl).toBe("https://gateway.local/v1");
  });

  // ── 7. resolveModel() throws for non-OpenAI-compatible unknowns ──────────

  test("resolveModel() throws for anthropic when not in catalog", () => {
    expect(() => resolveModel("anthropic", "some-fake-model")).toThrow(/anthropic/i);
  });
});
