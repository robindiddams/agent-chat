/**
 * reconnect.test.ts — Tests WS auto-reconnect + tools-while-disconnected.
 *
 * Part 1 (e2e): boots the server, starts the compiled agent binary, kills the
 *   server, restarts it, and verifies the agent reconnects and rejoins.
 *   Then POST stop → clean exit 0.
 *
 * Part 2 (unit): constructs a disconnected harness, calls send tools, verifies
 *   they return "connection down" results rather than silently no-op'ing.
 *
 * DB URL: TEST_DATABASE_URL || DATABASE_URL (or fall back to server/.env).
 * Self-cleaning. Never logs secrets.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { ChatHarness } from "./harness";
import { createChatTools } from "./tools";

// ── Config ───────────────────────────────────────────────────────────────

let DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const envPath = resolve(import.meta.dir, "../../server/.env");
    const envText = readFileSync(envPath, "utf-8");
    const match = envText.match(/^DATABASE_URL\s*=\s*(.+)$/m);
    if (match) DB_URL = match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {}
}
if (!DB_URL) {
  throw new Error("Neither TEST_DATABASE_URL nor DATABASE_URL is set.");
}

const testSql = new SQL(DB_URL);
const RUN_ID = Date.now();

// ── Helpers ──────────────────────────────────────────────────────────────

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
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function waitForAgentOnline(port: number, name: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/agents`);
      if (res.ok) {
        const body = await res.json();
        if (body.agents?.includes(name)) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ── Pre/post counts ──────────────────────────────────────────────────────

let preMsgCount = 0;
let preChannelCount = 0;
let preAgentCount = 0;
let preTokenCount = 0;

// ── Part 1: E2E reconnect ────────────────────────────────────────────────

describe("reconnect: server kill → agent reconnects", () => {
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let agentProc: ReturnType<typeof Bun.spawn> | null = null;
  let testPort = 0;
  let agentName = `recon-${RUN_ID}`;

  beforeAll(async () => {
    const [m] = await testSql`SELECT count(*)::int AS n FROM messages`;
    preMsgCount = m.n;
    const [c] = await testSql`SELECT count(*)::int AS n FROM channels`;
    preChannelCount = c.n;
    const [a] = await testSql`SELECT count(*)::int AS n FROM agents`;
    preAgentCount = a.n;
    const [t] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    preTokenCount = t.n;
  });

  afterAll(async () => {
    if (agentProc) {
      try { agentProc.kill(); } catch {}
      try { await agentProc.exited; } catch {}
    }
    if (serverProc) {
      try { serverProc.kill(); } catch {}
      try { await serverProc.exited; } catch {}
    }
    // Clean up test data (agent + its messages)
    await testSql`DELETE FROM messages WHERE sender_name = ${agentName}`;
    await testSql`DELETE FROM agents WHERE name = ${agentName}`;
    // Verify pre-existing data intact
    const [m] = await testSql`SELECT count(*)::int AS n FROM messages`;
    const [c] = await testSql`SELECT count(*)::int AS n FROM channels`;
    const [a] = await testSql`SELECT count(*)::int AS n FROM agents`;
    const [t] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    expect(m.n).toBe(preMsgCount);
    expect(c.n).toBe(preChannelCount);
    expect(a.n).toBe(preAgentCount);
    expect(t.n).toBe(preTokenCount);
    await testSql.close();
  }, 20_000);

  test("agent joins, survives server restart, and stops cleanly", async () => {
    testPort = getFreePort();
    const serverPath = import.meta.dir + "/../../server/src/server.ts";
    const serverCwd = import.meta.dir + "/../../server";

    // 1. Start the server
    serverProc = Bun.spawn({
      cmd: ["bun", "run", serverPath],
      cwd: serverCwd,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL!,
        PORT: String(testPort),
        FIREWORKS_API_KEY: "test-dummy-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(testPort);

    // 2. Create an agent
    const base = `http://localhost:${testPort}`;
    const cre = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "reconnect test agent", name: agentName }),
    });
    expect(cre.status).toBe(201);
    const created = await cre.json();

    // 3. Start the compiled agent binary
    const agentBin = import.meta.dir + "/../dist/agent";
    agentProc = Bun.spawn({
      cmd: [agentBin, "--token", created.token, "--server", base],
      cwd: import.meta.dir + "/..",
      env: {
        ...process.env,
        DATABASE_URL: DB_URL!,
        FIREWORKS_API_KEY: "test-dummy-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // 4. Wait for the agent to join
    const joined = await waitForAgentOnline(testPort, agentName, 15_000);
    expect(joined).toBe(true);

    // 5. Kill the server
    serverProc!.kill();
    try { await serverProc!.exited; } catch {}
    serverProc = null;
    console.log("Server killed — agent should start reconnecting...");

    // Wait a moment for the agent to notice the disconnect
    await new Promise((r) => setTimeout(r, 2_000));

    // 6. Restart the server on the same port
    // Small delay to let the OS release the port
    await new Promise((r) => setTimeout(r, 500));
    serverProc = Bun.spawn({
      cmd: ["bun", "run", serverPath],
      cwd: serverCwd,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL!,
        PORT: String(testPort),
        FIREWORKS_API_KEY: "test-dummy-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(testPort);
    console.log("Server restarted — waiting for agent to rejoin...");

    // 7. Wait for the agent to rejoin
    const rejoined = await waitForAgentOnline(testPort, agentName, 15_000);
    expect(rejoined).toBe(true);

    // 8. Stop the agent cleanly
    const stopRes = await fetch(`${base}/api/agents/${agentName}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(200);
    const stopBody = await stopRes.json();
    expect(stopBody.ok).toBe(true);

    // 9. Verify clean exit
    const exitCode = await agentProc.exited;
    expect(exitCode).toBe(0);
  }, 60_000);
});

// ── Part 2: Unit — tools while disconnected ──────────────────────────────

describe("tools while disconnected: returns down result (no silent no-op)", () => {
  test("send_message returns 'connection down' when not connected", async () => {
    // Set a very short tool wait timeout so the test is fast
    process.env.AGENT_TOOL_WAIT_MS = "50";
    // Create a harness that is not connected to anything
    const harness = new ChatHarness("ws://localhost:1/invalid", "test-agent", "fake-token");
    expect(harness.isConnected()).toBe(false);

    // Set a very short tool wait timeout so the test is fast
    const tools = createChatTools(harness);
    const sendTool = tools.find((t) => t.name === "send_message")!;
    expect(sendTool).toBeDefined();

    // Execute the tool — it should wait briefly, then return the "down" result
    // We set AGENT_TOOL_WAIT_MS=50 in the test env to make this fast
    const result = await sendTool.execute("test-call-id", { text: "hello" });

    // Should contain text about the connection being down
    const text = result.content.map((c: any) => c.text).join("");
    expect(text).toMatch(/connection is down/i);
    expect(result.details).toMatchObject({ sent: false, connected: false });
  });

  test("isConnected() and waitForConnection() work on a disconnected harness", async () => {
    const harness = new ChatHarness("ws://localhost:1/invalid", "test-agent", "fake-token");

    expect(harness.isConnected()).toBe(false);

    // waitForConnection with a short timeout should return false quickly
    const connected = await harness.waitForConnection(100);
    expect(connected).toBe(false);
  });
});
