/**
 * Chat tools for the Pi Agent.
 *
 * These tools let the LLM interact with the chat server:
 * - send_message: post to the group chat
 * - dm: send a private direct message
 * - list_agents: see who's currently online
 *
 * Plus coding tools:
 * - read_file: read file contents
 * - write_file: write/create files
 * - bash: execute shell commands
 *
 * Each tool conforms to Pi's AgentTool interface:
 *   { name, label, description, parameters, execute }
 * where execute returns AgentToolResult<T> = { content: (TextContent|ImageContent)[], details: T }
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatHarness } from "./harness";
import { readFile, writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { dirname } from "path";

/** How long send tools wait for reconnection before reporting "down" (ms). Tunable via env for tests. */
function toolWaitMs(): number {
  return parseInt(process.env.AGENT_TOOL_WAIT_MS || "30000", 10);
}

/**
 * Create the chat tools that the LLM can invoke.
 * The harness reference lets tools send messages via WebSocket.
 */
export function createChatTools(harness: ChatHarness): AgentTool<any>[] {
  return [
    {
      name: "send_message",
      label: "Send Chat Message",
      description:
        "Send a message to the group chat that everyone can see.",
      parameters: Type.Object({
        text: Type.String({ description: "The message to send" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { text: string },
      ) => {
        if (harness.isConnected()) {
          harness.sendMessage(params.text);
          return {
            content: [{ type: "text" as const, text: `Message sent to chat: ${params.text}` }],
            details: { sent: true },
          };
        }
        // Connection is down — wait up to 30s for reconnect, then report.
        const reconnected = await harness.waitForConnection(toolWaitMs());
        if (reconnected) {
          harness.sendMessage(params.text);
          return {
            content: [{ type: "text" as const, text: `Message sent to chat (after reconnect): ${params.text}` }],
            details: { sent: true, waited: true },
          };
        }
        return {
          content: [{ type: "text" as const, text: "Chat connection is down (reconnecting in background). The message was NOT sent. You can retry send_message later, or continue other work." }],
          details: { sent: false, connected: false },
        };
      },
    },
    {
      name: "dm",
      label: "Direct Message",
      description:
        "Send a private direct message to a specific agent or user. Use list_agents to see who's online first.",
      parameters: Type.Object({
        to: Type.String({ description: "Name of the agent or user to DM" }),
        text: Type.String({ description: "The message to send" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { to: string; text: string },
      ) => {
        if (harness.isConnected()) {
          harness.sendDm(params.to, params.text);
          return {
            content: [
              { type: "text" as const, text: `DM sent to ${params.to}: ${params.text}` },
            ],
            details: { sent: true },
          };
        }
        const reconnected = await harness.waitForConnection(toolWaitMs());
        if (reconnected) {
          harness.sendDm(params.to, params.text);
          return {
            content: [
              { type: "text" as const, text: `DM sent to ${params.to} (after reconnect): ${params.text}` },
            ],
            details: { sent: true, waited: true },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Chat connection is down (reconnecting in background). The DM to ${params.to} was NOT sent. You can retry dm later, or continue other work.` }],
          details: { sent: false, connected: false },
        };
      },
    },
    {
      name: "list_agents",
      label: "List Online Agents",
      description:
        "List all agents and users currently online in the chat.",
      parameters: Type.Object({}),
      execute: async () => {
        const names = harness.getOnlineAgents();
        const text =
          names.length > 0
            ? `Online: ${names.join(", ")}`
            : "Nobody else is online.";
        return {
          content: [{ type: "text" as const, text }],
          details: { agents: names },
        };
      },
    },

    // ── Channel tools ────────────────────────────────

    {
      name: "join_channel",
      label: "Join Channel",
      description:
        "Join a chat channel. Once joined, you'll receive notifications when new messages are posted. Use read_channel to see the actual messages.",
      parameters: Type.Object({
        channel: Type.String({ description: "Name of the channel to join" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { channel: string },
      ) => {
        harness.joinChannel(params.channel);
        return {
          content: [
            { type: "text" as const, text: `Joined #${params.channel}. You'll be notified of new messages.` },
          ],
          details: {},
        };
      },
    },
    {
      name: "read_channel",
      label: "Read Channel",
      description:
        "Read messages from a channel you've joined. Returns the message history for that channel.",
      parameters: Type.Object({
        channel: Type.String({ description: "Name of the channel to read" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { channel: string },
      ) => {
        const messages = await harness.readChannel(params.channel);
        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No messages in #${params.channel} yet.` }],
            details: { messages: [] },
          };
        }
        const formatted = messages
          .map((m) => `[${new Date(m.time).toLocaleTimeString()}] ${m.from}: ${m.text}`)
          .join("\n");
        return {
          content: [
            { type: "text" as const, text: `Messages in #${params.channel}:\n${formatted}` },
          ],
          details: { messages },
        };
      },
    },
    {
      name: "send_channel_message",
      label: "Send Channel Message",
      description:
        "Send a message to a channel you've joined.",
      parameters: Type.Object({
        channel: Type.String({ description: "Channel name" }),
        text: Type.String({ description: "Message to send" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { channel: string; text: string },
      ) => {
        if (harness.isConnected()) {
          harness.sendChannelMessage(params.channel, params.text);
          return {
            content: [
              { type: "text" as const, text: `Sent to #${params.channel}: ${params.text}` },
            ],
            details: { sent: true },
          };
        }
        const reconnected = await harness.waitForConnection(toolWaitMs());
        if (reconnected) {
          harness.sendChannelMessage(params.channel, params.text);
          return {
            content: [
              { type: "text" as const, text: `Sent to #${params.channel} (after reconnect): ${params.text}` },
            ],
            details: { sent: true, waited: true },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Chat connection is down (reconnecting in background). The message to #${params.channel} was NOT sent. You can retry send_channel_message later, or continue other work.` }],
          details: { sent: false, connected: false },
        };
      },
    },

    // ── Coding tools ─────────────────────────────────

    {
      name: "read_file",
      label: "Read File",
      description:
        "Read the contents of a file. Returns the file content as text.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to read" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { path: string },
      ) => {
        try {
          const content = await readFile(params.path, "utf-8");
          return {
            content: [{ type: "text" as const, text: content }],
            details: { path: params.path, size: content.length },
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error reading file: ${e.message}` }],
            details: { error: e.message },
          };
        }
      },
    },
    {
      name: "write_file",
      label: "Write File",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories as needed.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to write" }),
        content: Type.String({ description: "Content to write to the file" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { path: string; content: string },
      ) => {
        try {
          // Ensure parent directory exists
          await mkdir(dirname(params.path), { recursive: true });
          await writeFile(params.path, params.content, "utf-8");
          return {
            content: [{ type: "text" as const, text: `Wrote ${params.content.length} bytes to ${params.path}` }],
            details: { path: params.path, size: params.content.length },
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error writing file: ${e.message}` }],
            details: { error: e.message },
          };
        }
      },
    },
    {
      name: "bash",
      label: "Run Command",
      description:
        "Execute a shell command and return the output. Use for running builds, tests, git commands, etc.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to execute" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (optional)" })),
      }),
      execute: async (
        _toolCallId: string,
        params: { command: string; cwd?: string },
        signal?: AbortSignal,
      ) => {
        return new Promise((resolve) => {
          const proc = spawn("bash", ["-c", params.command], {
            cwd: params.cwd || process.cwd(),
            env: process.env,
          });

          let stdout = "";
          let stderr = "";

          proc.stdout.on("data", (data) => { stdout += data.toString(); });
          proc.stderr.on("data", (data) => { stderr += data.toString(); });

          // Handle abort signal
          if (signal) {
            signal.addEventListener("abort", () => {
              proc.kill("SIGTERM");
            });
          }

          // Timeout after 60 seconds
          const timeout = setTimeout(() => {
            proc.kill("SIGTERM");
            resolve({
              content: [{ type: "text" as const, text: `Command timed out after 60s.\nstdout:\n${stdout}\nstderr:\n${stderr}` }],
              details: { timeout: true, stdout, stderr },
            });
          }, 60000);

          proc.on("close", (code) => {
            clearTimeout(timeout);
            const output = [
              stdout && `stdout:\n${stdout}`,
              stderr && `stderr:\n${stderr}`,
              `exit code: ${code}`,
            ].filter(Boolean).join("\n\n");

            resolve({
              content: [{ type: "text" as const, text: output || "(no output)" }],
              details: { code, stdout, stderr },
            });
          });

          proc.on("error", (err) => {
            clearTimeout(timeout);
            resolve({
              content: [{ type: "text" as const, text: `Error executing command: ${err.message}` }],
              details: { error: err.message },
            });
          });
        });
      },
    },
  ];
}
