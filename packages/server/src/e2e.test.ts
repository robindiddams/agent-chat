/**
 * e2e.test.ts — End-to-end test for the Postgres-backed chat server.
 *
 * Boots the real server as a child process, connects over WebSocket, and
 * asserts BOTH wire-protocol responses AND underlying DB rows.
 *
 * DB URL is configurable: TEST_DATABASE_URL takes precedence over DATABASE_URL.
 * The connection string is never printed.
 *
 * Run:  bun test           (from packages/server/)
 *       bun test src/e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";

// ── Config ───────────────────────────────────────────────────────────────

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error(
    "Neither TEST_DATABASE_URL nor DATABASE_URL is set. " +
      "Set one in packages/server/.env or the environment. " +
      "The connection string is never printed."
  );
}

// Test's own DB client for assertions (separate from the server's).
const testSql = new SQL(DB_URL);

// ── Unique identifiers (never touch existing data) ─────────────────────────

const RUN_ID = Date.now();
const USER = `e2e_${RUN_ID}_a`;
const CHANNEL = `e2e-${RUN_ID}`; // satisfies /^[a-z0-9][a-z0-9-]*$/
const MSG_TEXT = `e2e global msg ${RUN_ID}`;
const CH_MSG_TEXT = `e2e channel msg ${RUN_ID}`;

// ── Server child process state ─────────────────────────────────────────────

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let testPort = 0;

// ── Pre-test counts (to verify cleanup in afterAll) ────────────────────────

let preMsgCount = 0;
let preChannelCount = 0;
let preMemberCount = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Find a free TCP port by briefly opening a server on port 0. */
function getFreePort(): number {
  const temp = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = temp.port;
  temp.stop(true);
  return port;
}

/** Poll the server's HTTP endpoint until it responds, then grace-period. */
async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) {
        // Give async startup (seed + hydrate) a moment to finish.
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

/** Minimal WebSocket client that buffers incoming JSON messages. */
class TestClient {
  ws: WebSocket;
  buffer: any[] = [];
  private isClosed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      try {
        const data = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
        this.buffer.push(JSON.parse(data));
      } catch {
        // ignore non-JSON
      }
    };
    this.ws.onclose = () => {
      this.isClosed = true;
    };
  }

  async open(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS open timeout")), timeoutMs);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WS connection error"));
      };
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a message matching the predicate. Removes it from the buffer. */
  async waitFor(predicate: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = this.buffer.findIndex(predicate);
      if (idx >= 0) {
        const [found] = this.buffer.splice(idx, 1);
        return found;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `waitFor timeout after ${timeoutMs}ms — buffered types: [${this.buffer.map((m) => m.type).join(", ")}]`
    );
  }

  close(): void {
    this.ws.close();
  }

  /** Resolve once the socket is closed (with fallback timeout). */
  async waitForClose(timeoutMs = 3000): Promise<void> {
    if (this.isClosed) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isClosed) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("e2e: Postgres-backed chat server", () => {
  let client: TestClient;

  beforeAll(async () => {
    // Capture pre-test row counts so afterAll can verify no data was lost.
    const [msgRow] = await testSql`SELECT count(*)::int AS n FROM messages`;
    preMsgCount = msgRow.n;
    const [chanRow] = await testSql`SELECT count(*)::int AS n FROM channels`;
    preChannelCount = chanRow.n;
    const [memRow] = await testSql`SELECT count(*)::int AS n FROM channel_members`;
    preMemberCount = memRow.n;

    // Boot server as an isolated child process.
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
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForServer(testPort);
  }, 15_000);

  afterAll(async () => {
    // Kill the server child.
    if (serverProc) {
      serverProc.kill();
      try {
        await serverProc.exited;
      } catch {
        // already dead
      }
    }

    // Cleanup: delete exactly the test rows.
    // Deleting the channel cascades to channel_members.
    await testSql`DELETE FROM channels WHERE name = ${CHANNEL}`;
    await testSql`DELETE FROM messages WHERE sender_name = ${USER}`;

    // Verify pre-existing data is intact.
    const [msgRow] = await testSql`SELECT count(*)::int AS n FROM messages`;
    const [chanRow] = await testSql`SELECT count(*)::int AS n FROM channels`;
    const [memRow] = await testSql`SELECT count(*)::int AS n FROM channel_members`;
    expect(msgRow.n).toBe(preMsgCount);
    expect(chanRow.n).toBe(preChannelCount);
    expect(memRow.n).toBe(preMemberCount);

    await testSql.close();
  });

  // ── a. Join → receive channels_list ──────────────────────────────────────

  test("join → receive channels_list", async () => {
    client = new TestClient(`ws://localhost:${testPort}/ws`);
    await client.open();
    client.send({ type: "join", name: USER });

    const channelsList = await client.waitFor((m) => m.type === "channels_list");
    expect(channelsList).toBeDefined();
    expect(Array.isArray(channelsList.channels)).toBe(true);
  });

  // ── b. Global message → broadcast echo + DB row ──────────────────────────

  test("global message → broadcast echo + DB row", async () => {
    client.send({ type: "message", text: MSG_TEXT });

    const echo = await client.waitFor(
      (m) => m.type === "message" && m.from === USER && m.text === MSG_TEXT
    );
    expect(echo.text).toBe(MSG_TEXT);
    expect(echo.from).toBe(USER);

    // Assert the row landed in Postgres.
    const [row] = await testSql`
      SELECT count(*)::int AS n FROM messages
      WHERE kind = 'message' AND sender_name = ${USER} AND body = ${MSG_TEXT}
    `;
    expect(row.n).toBe(1);
  });

  // ── c. create_channel → DB membership row ────────────────────────────────

  test("create_channel → DB membership row", async () => {
    client.send({ type: "create_channel", channel: CHANNEL });

    const created = await client.waitFor(
      (m) => m.type === "channel_created" && m.channel === CHANNEL
    );
    expect(created.by).toBe(USER);

    // createChannel auto-joins the creator — assert the channel_members row.
    const [row] = await testSql`
      SELECT count(*)::int AS n FROM channel_members
      WHERE channel_name = ${CHANNEL} AND member_name = ${USER}
    `;
    expect(row.n).toBe(1);
  });

  // ── d. channel_message → read_channel round-trips from Postgres ──────────

  test("channel_message → read_channel round-trips from Postgres", async () => {
    client.send({ type: "channel_message", channel: CHANNEL, text: CH_MSG_TEXT });

    const echo = await client.waitFor(
      (m) => m.type === "channel_message" && m.channel === CHANNEL && m.text === CH_MSG_TEXT
    );
    expect(echo.text).toBe(CH_MSG_TEXT);

    // Now read_channel — should pull from Postgres and round-trip.
    client.send({ type: "read_channel", channel: CHANNEL });
    const msgs = await client.waitFor(
      (m) => m.type === "channel_messages" && m.channel === CHANNEL
    );
    const found = msgs.messages.find((m: any) => m.text === CH_MSG_TEXT);
    expect(found).toBeDefined();
    expect(found.channel).toBe(CHANNEL);
    expect(found.type).toBe("channel_message");
  });

  // ── e. Persistent membership survives disconnect ─────────────────────────

  test("persistent membership survives disconnect", async () => {
    // Close the current socket — disconnect is presence, not leaving.
    client.close();
    await client.waitForClose();
    // Give the server a moment to process the close event.
    await new Promise((r) => setTimeout(r, 300));

    // Reconnect as the same user.
    client = new TestClient(`ws://localhost:${testPort}/ws`);
    await client.open();
    client.send({ type: "join", name: USER });
    await client.waitFor((m) => m.type === "channels_list");

    // DB membership row must still exist.
    const [row] = await testSql`
      SELECT count(*)::int AS n FROM channel_members
      WHERE channel_name = ${CHANNEL} AND member_name = ${USER}
    `;
    expect(row.n).toBe(1);

    // The user should still be able to read_channel — proves membership is active.
    client.send({ type: "read_channel", channel: CHANNEL });
    const msgs = await client.waitFor(
      (m) => m.type === "channel_messages" && m.channel === CHANNEL
    );
    expect(msgs.messages.length).toBeGreaterThan(0);
  });
});
