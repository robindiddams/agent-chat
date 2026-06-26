/**
 * ChatHarness: Bridges the WebSocket chat server with Pi's Agent.
 *
 * Connects to the chat server, sends a "join" message (with access token),
 * and routes incoming messages (@mentions and DMs) to the Pi Agent via
 * prompt()/steer(). Provides methods for tools to send messages back to the chat.
 *
 * On "history" the messages are captured so the caller can fold them into the
 * agent's system prompt as a priming context block.
 *
 * On "shutdown" the harness closes the WS and exits the process.
 *
 * ## Reconnect resilience
 *
 * If the WS drops (server restart, network blip) and the close was NOT
 * intentional (shutdown or explicit disconnect), the harness auto-reconnects
 * with backoff (1s → 2s → 5s → 10s cap). It keeps trying for up to
 * RECONNECT_TIMEOUT_MS (default 1 hour) before giving up and exiting nonzero.
 * An agent mid-prompt() continues uninterrupted — WS failure never crashes the
 * process.
 *
 * While disconnected, send methods return false and tools can wait for
 * reconnection via waitForConnection().
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { StoredMessage } from "../../server/src/protocol";

// ── Tunables ──────────────────────────────────────────

/** How long to keep trying to reconnect before giving up (1 hour). */
const RECONNECT_TIMEOUT_MS = 60 * 60 * 1000;

/** Backoff sequence in ms. After the last entry, repeats the last value. */
const BACKOFF_SEQUENCE = [1_000, 2_000, 5_000, 10_000];

export class ChatHarness {
  private ws: WebSocket | null = null;
  private agent: Agent | null = null;
  private running = false; // guards against concurrent prompt() calls
  private onlineAgents = new Set<string>();
  private name: string;
  private token: string;
  private url: string;

  // Captured history from the server (refreshed on each join)
  private history: StoredMessage[] = [];

  // Channels the agent has joined
  private joinedChannels = new Set<string>();

  // Pending read_channel callbacks (for request/response pattern)
  private pendingReads = new Map<string, (messages: Array<{ from: string; text: string; time: number }>) => void>();

  // ── Reconnect state ────────────────────────────────

  private intentionalClose = false;
  private joined = false; // has the initial join completed?
  private joinResolve: (() => void) | null = null;
  private joinReject: ((e: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDisconnectTime: number | null = null;
  private backoffIndex = 0;

  constructor(url: string, name: string, token: string) {
    this.url = url;
    this.name = name;
    this.token = token;
  }

  /** Wire the Pi Agent to this harness (call before connect). */
  setAgent(agent: Agent): void {
    this.agent = agent;

    // Subscribe to agent events for logging
    agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          console.log(`[${this.name}] thinking...`);
          break;
        case "agent_end":
          console.log(`[${this.name}] done.`);
          break;
        case "tool_execution_start":
          console.log(`[${this.name}] calling tool: ${event.toolName}`);
          break;
        case "tool_execution_end":
          console.log(
            `[${this.name}] tool ${event.toolName} ${event.isError ? "failed" : "completed"}`
          );
          break;
      }
    });
  }

  /** Return the chat history captured during join (refreshed on reconnect). */
  getHistory(): StoredMessage[] {
    return this.history;
  }

  /** Is the WebSocket currently connected and open? */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Wait up to timeoutMs for the connection to come back.
   * Returns true if connected, false if still down after the timeout.
   */
  async waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      if (this.isConnected()) return true;
    }
    return false;
  }

  /**
   * Connect to the chat server and join.
   * Returns a promise that resolves when the first "joined" event is received.
   * If the server is unreachable, the promise does NOT reject — the harness
   * starts auto-reconnecting and resolves when it eventually joins.
   * If RECONNECT_TIMEOUT_MS passes without a successful join, the process exits.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      this.doConnect();
    });
  }

  /**
   * Create a new WebSocket and wire up all event handlers.
   * Called on initial connect and on each reconnect.
   */
  private doConnect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`[${this.name}] Failed to create WebSocket:`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      console.log(`[${this.name}] WebSocket connected, sending join...`);
      ws.send(JSON.stringify({ type: "join", name: this.name, token: this.token }));
    };

    ws.onerror = (event) => {
      // Don't crash — let onclose handle reconnect.
      // Only log if this is the initial connect attempt.
      console.error(`[${this.name}] WebSocket error (will retry on close)`);
    };

    ws.onclose = (event) => {
      console.log(
        `[${this.name}] WebSocket closed (code=${event.code}, reason=${event.reason || "none"})`
      );
      this.ws = null;

      if (this.intentionalClose) {
        // Shutdown or explicit disconnect — don't reconnect.
        if (!this.joined && this.joinReject) {
          this.joinReject(new Error("Connection closed before join"));
        }
        return;
      }

      // Unintentional close — start / continue reconnecting.
      if (!this.joined && this.joinReject) {
        // Initial connect failed — don't reject; start reconnecting instead.
        // Replace reject with a no-op so the promise stays pending.
        this.joinReject = null;
      }
      this.scheduleReconnect();
    };

    ws.onmessage = (event) => {
      this.handleMessage(event);
    };
  }

  /**
   * Schedule a reconnect attempt with backoff.
   * Gives up after RECONNECT_TIMEOUT_MS from the first disconnect.
   */
  private scheduleReconnect(): void {
    // Clear any existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Track when we first started disconnecting
    if (this.firstDisconnectTime === null) {
      this.firstDisconnectTime = Date.now();
    }

    // Check if we've exceeded the total timeout
    const elapsed = Date.now() - this.firstDisconnectTime;
    if (elapsed >= RECONNECT_TIMEOUT_MS) {
      console.error(
        `[${this.name}] Reconnect timeout (${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s) exceeded. Giving up.`
      );
      process.exit(1);
    }

    const delay = BACKOFF_SEQUENCE[Math.min(this.backoffIndex, BACKOFF_SEQUENCE.length - 1)];
    this.backoffIndex++;

    const remaining = Math.round((RECONNECT_TIMEOUT_MS - elapsed) / 1000);
    console.log(
      `[${this.name}] Reconnecting in ${delay / 1000}s (${remaining}s remaining until give-up)...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  /** Reset reconnect state on successful join. */
  private resetReconnectState(): void {
    this.firstDisconnectTime = null;
    this.backoffIndex = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Handle an incoming WebSocket message. */
  private handleMessage(event: MessageEvent): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      console.error(`[${this.name}] Failed to parse server message`);
      return;
    }

    switch (msg.type) {
      case "joined": {
        this.onlineAgents = new Set(
          (msg.names as string[]).filter((n: string) => n !== this.name)
        );
        console.log(
          `[${this.name}] ${msg.name} joined. Online: [${Array.from(this.onlineAgents).join(", ")}]`
        );

        if (msg.name === this.name) {
          // Successfully (re)joined — reset reconnect state
          this.resetReconnectState();

          if (!this.joined) {
            this.joined = true;
            if (this.joinResolve) {
              this.joinResolve();
              this.joinResolve = null;
              this.joinReject = null;
            }
          }
        }
        break;
      }

      case "left": {
        this.onlineAgents.delete(msg.name);
        console.log(`[${this.name}] ${msg.name} left.`);
        break;
      }

      case "history": {
        this.history = Array.isArray(msg.messages) ? msg.messages : [];
        console.log(`[${this.name}] Received ${this.history.length} history messages.`);
        break;
      }

      case "message": {
        if (msg.from === this.name) break;
        if (typeof msg.text === "string" && msg.text.includes(`@${this.name}`)) {
          this.handleIncoming(`[${msg.from} in chat]: ${msg.text}`);
        }
        break;
      }

      case "dm": {
        if (msg.from === this.name) break;
        this.handleIncoming(`[DM from ${msg.from}]: ${msg.text}`);
        break;
      }

      case "channel_created": {
        console.log(`[${this.name}] Channel #${msg.channel} created by ${msg.by}`);
        break;
      }

      case "channel_joined": {
        if (msg.name === this.name) {
          this.joinedChannels.add(msg.channel);
        }
        console.log(
          `[${this.name}] ${msg.name} joined #${msg.channel}. Members: [${(msg.members as string[]).join(", ")}]`
        );
        break;
      }

      case "channel_left": {
        if (msg.name === this.name) {
          this.joinedChannels.delete(msg.channel);
        }
        console.log(`[${this.name}] ${msg.name} left #${msg.channel}`);
        break;
      }

      case "channel_notification": {
        const note = `[background] Activity in #${msg.channel}. No response needed — check with read_channel only if relevant to your current task.`;
        if (this.running) {
          this.agent?.steer({
            role: "user",
            content: note,
            timestamp: Date.now(),
          });
        } else {
          this.handleIncoming(note);
        }
        break;
      }

      case "channel_message": {
        console.log(`[${this.name}] [#${msg.channel}] ${msg.from}: ${msg.text}`);
        break;
      }

      case "channel_messages": {
        const cb = this.pendingReads.get(msg.channel);
        if (cb) {
          this.pendingReads.delete(msg.channel);
          cb(
            (msg.messages as Array<{ from: string; text: string; time: number }>).map(
              (m) => ({ from: m.from, text: m.text, time: m.time })
            )
          );
        }
        break;
      }

      case "channels_list": {
        const names = (msg.channels as Array<{ name: string }>).map((c) => c.name);
        console.log(`[${this.name}] Available channels: [${names.join(", ")}]`);
        break;
      }

      case "shutdown": {
        console.log(`[${this.name}] shutdown received from server.`);
        this.intentionalClose = true;
        this.disconnect();
        process.exit(0);
      }

      case "error": {
        console.error(`[${this.name}] Server error: ${msg.message}`);

        // On initial connect, a server error (e.g. invalid token) is a real
        // failure — reject so the caller knows. On reconnect, just log it
        // (the reconnect loop will keep trying).
        if (!this.joined && this.joinReject) {
          this.joinReject(new Error(`Server error: ${msg.message}`));
          this.joinReject = null;
          this.joinResolve = null;
          // Don't reconnect on auth errors — the token won't get better.
          this.intentionalClose = true;
          this.disconnect();
        }
        break;
      }

      default:
        console.warn(`[${this.name}] Unknown server message type: ${msg.type}`);
    }
  }

  /** Disconnect from the chat server (intentional — no reconnect). */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Send methods (return true if sent, false if disconnected) ──

  /** Send a message to the group chat. Returns true if sent, false if down. */
  sendMessage(text: string): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type: "message", text }));
    return true;
  }

  /** Send a direct message. Returns true if sent, false if down. */
  sendDm(to: string, text: string): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type: "dm", to, text }));
    return true;
  }

  /** Get list of currently online agents (called by tools). */
  getOnlineAgents(): string[] {
    return Array.from(this.onlineAgents);
  }

  /** Get this agent's name. */
  getName(): string {
    return this.name;
  }

  // ── Channel methods (called by tools) ──────────────

  /** Join a channel. Returns true if request sent, false if down. */
  joinChannel(channel: string): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type: "join_channel", channel }));
    return true;
  }

  /** Leave a channel. Returns true if request sent, false if down. */
  leaveChannel(channel: string): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type: "leave_channel", channel }));
    return true;
  }

  /** Send a message to a channel. Returns true if sent, false if down. */
  sendChannelMessage(channel: string, text: string): boolean {
    if (!this.isConnected()) return false;
    this.ws!.send(JSON.stringify({ type: "channel_message", channel, text }));
    return true;
  }

  /** Read messages from a channel. Returns a promise that resolves with the message list. */
  readChannel(channel: string): Promise<Array<{ from: string; text: string; time: number }>> {
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve([]);
        return;
      }
      this.pendingReads.set(channel, resolve);
      this.ws!.send(JSON.stringify({ type: "read_channel", channel }));
      // Timeout after 5s
      setTimeout(() => {
        if (this.pendingReads.has(channel)) {
          this.pendingReads.delete(channel);
          resolve([]);
        }
      }, 5000);
    });
  }

  /** Get the list of channels this agent has joined. */
  getJoinedChannels(): string[] {
    return Array.from(this.joinedChannels);
  }

  /**
   * Handle an incoming chat message by routing it to the Pi Agent.
   * If the agent is busy (running), use steer() to interrupt.
   * If idle, use prompt() to start a new run.
   */
  private async handleIncoming(content: string): Promise<void> {
    if (!this.agent) return;

    const msg: UserMessage = {
      role: "user",
      content,
      timestamp: Date.now(),
    };

    if (this.running) {
      console.log(`[${this.name}] Steering (agent busy): ${content}`);
      this.agent.steer(msg);
      return;
    }

    this.running = true;
    try {
      console.log(`[${this.name}] Prompting: ${content}`);
      await this.agent.prompt(msg);
    } catch (e) {
      console.error(`[${this.name}] Agent error:`, e);
    } finally {
      this.running = false;
    }
  }
}
