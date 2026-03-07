import { existsSync, readFileSync } from "fs";
import type { StoredMessage } from "./protocol";

const HISTORY_FILE = process.env.HISTORY_FILE || "chat-history.json";

let messages: StoredMessage[] = [];

export function loadHistory(): void {
  if (existsSync(HISTORY_FILE)) {
    try {
      messages = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      console.log(`Loaded ${messages.length} messages from ${HISTORY_FILE}`);
    } catch (e) {
      console.warn(`Failed to load ${HISTORY_FILE}, starting fresh:`, e);
      messages = [];
    }
  }
}

export async function saveHistory(): Promise<void> {
  await Bun.write(HISTORY_FILE, JSON.stringify(messages, null, 2));
}

export function addMessage(msg: StoredMessage): void {
  messages.push(msg);
}

export function getHistory(): StoredMessage[] {
  return messages;
}

/** Get messages relevant to a specific user (global + their DMs) */
export function getHistoryFor(name: string): StoredMessage[] {
  return messages.filter(
    (m) => m.type === "message" || m.from === name || m.to === name
  );
}

/** Get all messages for a specific channel */
export function getChannelHistory(channel: string): StoredMessage[] {
  return messages.filter(
    (m) => m.type === "channel_message" && m.channel === channel
  );
}
