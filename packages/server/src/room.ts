import type { ServerWebSocket } from "bun";
import type { ServerMessage, StoredMessage, ChannelInfo } from "./protocol";
import { addMessage, saveHistory, getHistoryFor, getChannelHistory } from "./history";

export type SocketData = { name: string };
type Socket = ServerWebSocket<SocketData>;

const clients = new Map<string, Socket>();

// ── Channel state ────────────────────────────────────

type Channel = {
  name: string;
  members: Set<string>;
  createdBy: string;
};

const channels = new Map<string, Channel>();

// ── Helpers ──────────────────────────────────────────

export function getNames(): string[] {
  return Array.from(clients.keys());
}

export function isNameTaken(name: string): boolean {
  return clients.has(name);
}

function send(ws: Socket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function broadcastAll(msg: ServerMessage, exclude?: string): void {
  for (const [name, ws] of clients) {
    if (name !== exclude) {
      send(ws, msg);
    }
  }
}

// ── Join / Leave ─────────────────────────────────────

export function join(name: string, ws: Socket): void {
  clients.set(name, ws);
  ws.data.name = name;

  // Send history to the joiner
  const history = getHistoryFor(name);
  if (history.length > 0) {
    send(ws, { type: "history", messages: history });
  }

  // Send channels list so the joiner knows what's available
  send(ws, { type: "channels_list", channels: getChannelsList() });

  // Tell everyone (including joiner) about the join
  const names = getNames();
  broadcastAll({ type: "joined", name, names });
}

export function leave(ws: Socket): void {
  const name = ws.data.name;
  if (!name) return;
  clients.delete(name);

  // Remove from all channels
  for (const [, channel] of channels) {
    if (channel.members.has(name)) {
      channel.members.delete(name);
      // Notify remaining members
      for (const member of channel.members) {
        const memberWs = clients.get(member);
        if (memberWs) {
          send(memberWs, { type: "channel_left", channel: channel.name, name });
        }
      }
    }
  }

  broadcastAll({ type: "left", name });
}

// ── Global chat & DMs ───────────────────────────────

export async function broadcast(from: string, text: string): Promise<void> {
  const time = Date.now();
  const stored: StoredMessage = { type: "message", from, text, time };
  addMessage(stored);
  await saveHistory();
  broadcastAll({ type: "message", from, text, time });
}

export async function dm(from: string, to: string, text: string): Promise<boolean> {
  const target = clients.get(to);
  const time = Date.now();

  const stored: StoredMessage = { type: "dm", from, to, text, time };
  addMessage(stored);
  await saveHistory();

  if (target) {
    send(target, { type: "dm", from, text, time });
    return true;
  }
  return false; // recipient offline — message still saved for when they reconnect
}

export function sendError(ws: Socket, message: string): void {
  send(ws, { type: "error", message });
}

// ── Channel operations ──────────────────────────────

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function createChannel(name: string, creator: string, ws: Socket): void {
  if (!CHANNEL_NAME_RE.test(name)) {
    sendError(ws, "Channel name must be lowercase alphanumeric + dashes, starting with a letter or digit");
    return;
  }
  if (channels.has(name)) {
    sendError(ws, `Channel #${name} already exists`);
    return;
  }

  const channel: Channel = { name, members: new Set([creator]), createdBy: creator };
  channels.set(name, channel);

  // Notify ALL connected clients about the new channel
  broadcastAll({ type: "channel_created", channel: name, by: creator });

  // Send channel_joined to the creator
  send(ws, { type: "channel_joined", channel: name, name: creator, members: [creator] });
}

export function joinChannel(channelName: string, name: string, ws: Socket): void {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (channel.members.has(name)) {
    sendError(ws, `Already a member of #${channelName}`);
    return;
  }

  channel.members.add(name);
  const members = Array.from(channel.members);

  // Send channel_joined to ALL members of the channel (including the joiner)
  for (const member of channel.members) {
    const memberWs = clients.get(member);
    if (memberWs) {
      send(memberWs, { type: "channel_joined", channel: channelName, name, members });
    }
  }
}

export function leaveChannel(channelName: string, name: string, ws: Socket): void {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (!channel.members.has(name)) {
    sendError(ws, `Not a member of #${channelName}`);
    return;
  }

  channel.members.delete(name);

  // Notify remaining members
  for (const member of channel.members) {
    const memberWs = clients.get(member);
    if (memberWs) {
      send(memberWs, { type: "channel_left", channel: channelName, name });
    }
  }
}

export async function channelMessage(channelName: string, from: string, text: string): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) {
    const senderWs = clients.get(from);
    if (senderWs) sendError(senderWs, `Channel #${channelName} does not exist`);
    return;
  }
  if (!channel.members.has(from)) {
    const senderWs = clients.get(from);
    if (senderWs) sendError(senderWs, `Not a member of #${channelName}`);
    return;
  }

  const time = Date.now();
  const stored: StoredMessage = { type: "channel_message", from, text, time, channel: channelName };
  addMessage(stored);
  await saveHistory();

  // Send full message to the SENDER (so they see their own message)
  const senderWs = clients.get(from);
  if (senderWs) {
    send(senderWs, { type: "channel_message", channel: channelName, from, text, time });
  }

  // Send lightweight notification to OTHER members (no content!)
  for (const member of channel.members) {
    if (member !== from) {
      const memberWs = clients.get(member);
      if (memberWs) {
        send(memberWs, { type: "channel_notification", channel: channelName });
      }
    }
  }
}

export function readChannel(channelName: string, name: string, ws: Socket): void {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (!channel.members.has(name)) {
    sendError(ws, `Not a member of #${channelName}`);
    return;
  }

  const history = getChannelHistory(channelName);
  send(ws, { type: "channel_messages", channel: channelName, messages: history });
}

export function listChannels(ws: Socket): void {
  send(ws, { type: "channels_list", channels: getChannelsList() });
}

export function getChannelsList(): ChannelInfo[] {
  const list: ChannelInfo[] = [];
  for (const [, channel] of channels) {
    list.push({ name: channel.name, members: Array.from(channel.members) });
  }
  return list;
}
