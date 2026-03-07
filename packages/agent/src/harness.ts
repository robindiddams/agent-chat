/**
 * ChatHarness: Bridges the WebSocket chat server with Pi's Agent.
 *
 * Connects to the chat server, sends a "join" message, and routes
 * incoming messages (@mentions and DMs) to the Pi Agent via prompt()/steer().
 * Provides methods for tools to send messages back to the chat.
 */

import type { Agent } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";

export class ChatHarness {
  private ws: WebSocket | null = null;
  private agent: Agent | null = null;
  private running = false; // guards against concurrent prompt() calls
  private onlineAgents = new Set<string>();
  private name: string;
  private url: string;

  // Channels the agent has joined
  private joinedChannels = new Set<string>();

  // Pending read_channel callbacks (for request/response pattern)
  private pendingReads = new Map<string, (messages: Array<{ from: string; text: string; time: number }>) => void>();

  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
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

  /**
   * Connect to the chat server and join.
   * Returns a promise that resolves when the "joined" event is received.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        // Send join message
        ws.send(JSON.stringify({ type: "join", name: this.name }));
      };

      ws.onerror = (event) => {
        console.error(`[${this.name}] WebSocket error:`, event);
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = (event) => {
        console.log(
          `[${this.name}] WebSocket closed (code=${event.code}, reason=${event.reason})`
        );
        this.ws = null;
      };

      let joined = false;

      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          console.error(`[${this.name}] Failed to parse server message`);
          return;
        }

        switch (msg.type) {
          case "joined": {
            // Update online agents list from the full names array
            this.onlineAgents = new Set(
              (msg.names as string[]).filter((n: string) => n !== this.name)
            );
            console.log(
              `[${this.name}] ${msg.name} joined. Online: [${Array.from(this.onlineAgents).join(", ")}]`
            );

            // Resolve the connect() promise on our own join
            if (msg.name === this.name && !joined) {
              joined = true;
              resolve();
            }
            break;
          }

          case "left": {
            this.onlineAgents.delete(msg.name);
            console.log(`[${this.name}] ${msg.name} left.`);
            break;
          }

          case "history": {
            const count = Array.isArray(msg.messages) ? msg.messages.length : 0;
            console.log(`[${this.name}] Received ${count} history messages (skipping).`);
            break;
          }

          case "message": {
            // Only respond to @mentions (skip our own messages)
            if (msg.from === this.name) break;
            if (typeof msg.text === "string" && msg.text.includes(`@${this.name}`)) {
              this.handleIncoming(`[${msg.from} in chat]: ${msg.text}`);
            }
            break;
          }

          case "dm": {
            // Always respond to DMs
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
            // Lightweight ping — channel name only, no message content
            // Phrased to discourage reflexive responses
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
            // Echo of our own channel message — just log it
            console.log(
              `[${this.name}] [#${msg.channel}] ${msg.from}: ${msg.text}`
            );
            break;
          }

          case "channel_messages": {
            // Response to a read_channel request
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

          case "error": {
            console.error(`[${this.name}] Server error: ${msg.message}`);

            // If we haven't joined yet, reject the connect promise
            if (!joined) {
              joined = true;
              reject(new Error(`Server error: ${msg.message}`));
            }
            break;
          }

          default:
            console.warn(`[${this.name}] Unknown server message type: ${msg.type}`);
        }
      };
    });
  }

  /** Disconnect from the chat server. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Send a message to the group chat (called by tools). */
  sendMessage(text: string): void {
    this.ws?.send(JSON.stringify({ type: "message", text }));
  }

  /** Send a direct message to a specific agent (called by tools). */
  sendDm(to: string, text: string): void {
    this.ws?.send(JSON.stringify({ type: "dm", to, text }));
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

  /** Join a channel to receive notifications. */
  joinChannel(channel: string): void {
    this.ws?.send(JSON.stringify({ type: "join_channel", channel }));
  }

  /** Leave a channel. */
  leaveChannel(channel: string): void {
    this.ws?.send(JSON.stringify({ type: "leave_channel", channel }));
  }

  /** Send a message to a channel. */
  sendChannelMessage(channel: string, text: string): void {
    this.ws?.send(JSON.stringify({ type: "channel_message", channel, text }));
  }

  /** Read messages from a channel. Returns a promise that resolves with the message list. */
  readChannel(channel: string): Promise<Array<{ from: string; text: string; time: number }>> {
    return new Promise((resolve) => {
      this.pendingReads.set(channel, resolve);
      this.ws?.send(JSON.stringify({ type: "read_channel", channel }));
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
      // Agent is busy — interrupt with steering message
      console.log(`[${this.name}] Steering (agent busy): ${content}`);
      this.agent.steer(msg);
      return;
    }

    // Agent is idle — start a new run
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
