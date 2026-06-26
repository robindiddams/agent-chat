/**
 * agents.test.ts — Tests the create-agent + credential-handoff REST API + DB.
 *
 * Boots the server as a child process (same pattern as e2e.test.ts), exercises
 * POST /api/agents, POST /api/agents/bootstrap, validates one-time token
 * semantics, and tests access-token validation. Self-cleaning.
 *
 * DB URL: TEST_DATABASE_URL || DATABASE_URL.
 * A dummy FIREWORKS_API_KEY is injected so bootstrap succeeds for testing.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";

// ── Config ───────────────────────────────────────────────────────────────

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error("Neither TEST_DATABASE_URL nor DATABASE_URL is set.");
}

const testSql = new SQL(DB_URL);

const RUN_ID = Date.now();
const AGENT_NAME = `e2e-agent-${RUN_ID}`;
const AGENT_DESC = `e2e test agent ${RUN_ID}`;

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

let preMsgCount = 0;
let preChannelCount = 0;
let preAgentCount = 0;
let preTokenCount = 0;

describe("agents: create-agent + credential handoff", () => {
  beforeAll(async () => {
    const [msgRow] = await testSql`SELECT count(*)::int AS n FROM messages`;
    preMsgCount = msgRow.n;
    const [chanRow] = await testSql`SELECT count(*)::int AS n FROM channels`;
    preChannelCount = chanRow.n;
    const [agentRow] = await testSql`SELECT count(*)::int AS n FROM agents`;
    preAgentCount = agentRow.n;
    const [tokenRow] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    preTokenCount = tokenRow.n;

    testPort = getFreePort();
    const serverPath = import.meta.dir + "/server.ts";
    const cwd = import.meta.dir + "/..";

    serverProc = Bun.spawn({
      cmd: ["bun", "run", serverPath],
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        PORT: String(testPort),
        // Inject a dummy key so bootstrap succeeds for testing.
        FIREWORKS_API_KEY: "fw-test-dummy-key",
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
    const [msgRow] = await testSql`SELECT count(*)::int AS n FROM messages`;
    const [chanRow] = await testSql`SELECT count(*)::int AS n FROM channels`;
    const [agentRow] = await testSql`SELECT count(*)::int AS n FROM agents`;
    const [tokenRow] = await testSql`SELECT count(*)::int AS n FROM agent_tokens`;
    expect(msgRow.n).toBe(preMsgCount);
    expect(chanRow.n).toBe(preChannelCount);
    expect(agentRow.n).toBe(preAgentCount);
    expect(tokenRow.n).toBe(preTokenCount);

    await testSql.close();
  });

  // ── 1. Create an agent ──────────────────────────────────────────────────

  test("POST /api/agents creates an agent + returns command + token", async () => {
    const res = await fetch(`http://localhost:${testPort}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: AGENT_DESC, name: AGENT_NAME }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(AGENT_NAME);
    expect(body.command).toMatch(/^agent --token /);
    expect(body.token).toBeDefined();
    expect(body.token.length).toBe(16); // 12 bytes base64url = 16 chars

    // Verify the agent row in the DB
    const [row] = await testSql`
      SELECT name, status, system_prompt, provider, model FROM agents WHERE name = ${AGENT_NAME}
    `;
    expect(row.name).toBe(AGENT_NAME);
    expect(row.status).toBe("created");
    expect(row.system_prompt).toBe(AGENT_DESC); // stub: description = system prompt
    expect(row.provider).toBe("fireworks");
    expect(row.model).toBe("accounts/fireworks/models/glm-5p1");

    // Verify both token hashes were stored (no raw tokens)
    const tokens = await testSql`
      SELECT kind, token_hash, used_at FROM agent_tokens WHERE agent_name = ${AGENT_NAME} ORDER BY kind
    `;
    expect(tokens.length).toBe(2);
    expect(tokens[0].kind).toBe("access");
    expect(tokens[1].kind).toBe("bootstrap");
    // Hashes are SHA-256 hex (64 lowercase chars). Portable across runtimes.
    expect(tokens[0].token_hash.length).toBe(64);
    expect(tokens[1].token_hash.length).toBe(64);
  });

  // ── 2. Bootstrap: exchange token for credentials ────────────────────────

  test("full create → bootstrap → reusable bootstrap flow", async () => {
    // Use a distinct agent for this test
    const bootstrapAgentName = `e2e-boot-${RUN_ID}`;
    try {
      // Create
      const createRes = await fetch(`http://localhost:${testPort}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "bootstrap test agent", name: bootstrapAgentName }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      // Bootstrap — should succeed
      const bootRes = await fetch(`http://localhost:${testPort}/api/agents/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      });
      expect(bootRes.status).toBe(200);
      const creds = await bootRes.json();
      expect(creds.name).toBe(bootstrapAgentName);
      expect(creds.systemPrompt).toBe("bootstrap test agent");
      expect(creds.provider).toBe("fireworks");
      expect(creds.model).toBe("accounts/fireworks/models/glm-5p1");
      expect(creds.apiKey).toBe("fw-test-dummy-key");
      expect(creds.accessToken).toBeDefined();
      expect(creds.accessToken.length).toBe(16);
      expect(creds.wsUrl).toBe(`ws://localhost:${testPort}/ws`);
      const firstAccessToken = creds.accessToken;

      // Verify agent status is 'provisioned'
      const [agentRow] = await testSql`
        SELECT status FROM agents WHERE name = ${bootstrapAgentName}
      `;
      expect(agentRow.status).toBe("provisioned");

      // Second bootstrap with the SAME token — should SUCCEED (reusable)
      const bootRes2 = await fetch(`http://localhost:${testPort}/api/agents/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      });
      expect(bootRes2.status).toBe(200);
      const creds2 = await bootRes2.json();
      expect(creds2.name).toBe(bootstrapAgentName);
      expect(creds2.accessToken).toBeDefined();
      // Each bootstrap mints a fresh access token (old one invalidated)
      expect(creds2.accessToken).not.toBe(firstAccessToken);
    } finally {
      await testSql`DELETE FROM agents WHERE name = ${bootstrapAgentName}`;
    }
  });

  // ── 3. Access token validation via DB ───────────────────────────────────

  test("access token from bootstrap validates against the DB", async () => {
    const vAgentName = `e2e-val-${RUN_ID}`;
    try {
      // Create + bootstrap to get an access token
      const createRes = await fetch(`http://localhost:${testPort}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "validation test", name: vAgentName }),
      });
      const created = await createRes.json();

      const bootRes = await fetch(`http://localhost:${testPort}/api/agents/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      });
      const creds = await bootRes.json();

      // Validate the access token exists in the DB
      const { hashToken } = await import("./tokens");
      const hash = hashToken("access", creds.accessToken);
      const rows = await testSql`
        SELECT id FROM agent_tokens
        WHERE agent_name = ${vAgentName} AND kind = 'access' AND token_hash = ${hash}
          AND (expires_at IS NULL OR expires_at > now())
      `;
      expect(rows.length).toBe(1);

      // A wrong token should not match
      const wrongHash = hashToken("access", "wrong-token-xyz");
      const wrongRows = await testSql`
        SELECT id FROM agent_tokens
        WHERE agent_name = ${vAgentName} AND kind = 'access' AND token_hash = ${wrongHash}
      `;
      expect(wrongRows.length).toBe(0);
    } finally {
      await testSql`DELETE FROM agents WHERE name = ${vAgentName}`;
    }
  });

  // ── 4. GET /api/agents lists the registry ───────────────────────────────

  test("GET /api/agents returns the registry", async () => {
    const res = await fetch(`http://localhost:${testPort}/api/agents`);
    expect(res.status).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    // Our test agent from test 1 should be in the list
    const found = agents.find((a: any) => a.name === AGENT_NAME);
    expect(found).toBeDefined();
    expect(found.status).toBe("created");
  });

  // ── 5. Stop endpoint ────────────────────────────────────────────────────

  test("POST /api/agents/:name/stop marks agent as stopped", async () => {
    // AGENT_NAME was created in test 1 but never connected via WS
    const res = await fetch(`http://localhost:${testPort}/api/agents/${AGENT_NAME}/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe(AGENT_NAME);
    expect(body.wsDelivered).toBe(false); // not connected via WS

    // Verify status in DB
    const [row] = await testSql`SELECT status FROM agents WHERE name = ${AGENT_NAME}`;
    expect(row.status).toBe("stopped");
  });

  // ── 6. Bootstrap with a bogus token ─────────────────────────────────────

  test("POST /api/agents/bootstrap with bogus token returns 401", async () => {
    const res = await fetch(`http://localhost:${testPort}/api/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-bogus!" }),
    });
    expect(res.status).toBe(401);
  });
});
