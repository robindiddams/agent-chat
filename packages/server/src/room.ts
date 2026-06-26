import type { ServerWebSocket } from "bun";
import type { ServerMessage, StoredMessage, ChannelInfo } from "./protocol";
import { addMessage, getHistoryFor, getChannelHistory } from "./history";
import { sql } from "./db";

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

// ── Hydration (call once on startup) ─────────────────

/** Load channels + membership from Postgres into the in-memory Map. */
export async function hydrateChannels(): Promise<void> {
  const chans = await sql<{ name: string; created_by: string }[]>`
    SELECT name, created_by FROM channels
  `;
  for (const c of chans) {
    channels.set(c.name, { name: c.name, members: new Set(), createdBy: c.created_by });
  }

  const members = await sql<{ channel_name: string; member_name: string }[]>`
    SELECT channel_name, member_name FROM channel_members
  `;
  for (const m of members) {
    const ch = channels.get(m.channel_name);
    if (ch) ch.members.add(m.member_name);
  }

  console.log(`Hydrated ${chans.length} channels, ${members.length} memberships from DB.`);
}

// ── Helpers ──────────────────────────────────────────

export function getNames(): string[] {
  return Array.from(clients.keys());
}

export function isNameTaken(name: string): boolean {
  return clients.has(name);
}

/** Get the live socket for a connected client (or undefined if offline). */
export function getSocket(name: string): Socket | undefined {
  return clients.get(name);
}

/** Send a message to a specific connected client by name. */
export function sendTo(name: string, msg: ServerMessage): boolean {
  const ws = clients.get(name);
  if (!ws) return false;
  send(ws, msg);
  return true;
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

export async function join(name: string, ws: Socket): Promise<void> {
  clients.set(name, ws);
  ws.data.name = name;

  // Send history to the joiner
  const history = await getHistoryFor(name);
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

  // NOTE: disconnect is presence, not leaving a channel.
  // We do NOT remove the user from the in-memory members Set or the
  // channel_members table — membership is persistent (Slack-like).
  // Only an explicit leave_channel removes membership.
  // No channel_left is emitted on disconnect.

  broadcastAll({ type: "left", name });
}

// ── Global chat & DMs ───────────────────────────────

export async function broadcast(from: string, text: string): Promise<void> {
  const time = Date.now();
  const stored: StoredMessage = { type: "message", from, text, time };
  await addMessage(stored);
  broadcastAll({ type: "message", from, text, time });
}

export async function dm(from: string, to: string, text: string): Promise<boolean> {
  const target = clients.get(to);
  const time = Date.now();

  const stored: StoredMessage = { type: "dm", from, to, text, time };
  await addMessage(stored);

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

export async function createChannel(name: string, creator: string, ws: Socket): Promise<void> {
  if (!CHANNEL_NAME_RE.test(name)) {
    sendError(ws, "Channel name must be lowercase alphanumeric + dashes, starting with a letter or digit");
    return;
  }
  if (channels.has(name)) {
    sendError(ws, `Channel #${name} already exists`);
    return;
  }

  await sql`
    INSERT INTO channels (name, created_by) VALUES (${name}, ${creator})
    ON CONFLICT (name) DO NOTHING
  `;
  await sql`
    INSERT INTO channel_members (channel_name, member_name) VALUES (${name}, ${creator})
    ON CONFLICT DO NOTHING
  `;

  const channel: Channel = { name, members: new Set([creator]), createdBy: creator };
  channels.set(name, channel);

  // Notify ALL connected clients about the new channel
  broadcastAll({ type: "channel_created", channel: name, by: creator });

  // Send channel_joined to the creator
  send(ws, { type: "channel_joined", channel: name, name: creator, members: [creator] });
}

export async function joinChannel(channelName: string, name: string, ws: Socket): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (channel.members.has(name)) {
    sendError(ws, `Already a member of #${channelName}`);
    return;
  }

  await sql`
    INSERT INTO channel_members (channel_name, member_name) VALUES (${channelName}, ${name})
    ON CONFLICT DO NOTHING
  `;

  channel.members.add(name);
  const members = Array.from(channel.members);

  // Send channel_joined to ALL currently-connected members of the channel
  for (const member of channel.members) {
    const memberWs = clients.get(member);
    if (memberWs) {
      send(memberWs, { type: "channel_joined", channel: channelName, name, members });
    }
  }
}

export async function leaveChannel(channelName: string, name: string, ws: Socket): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (!channel.members.has(name)) {
    sendError(ws, `Not a member of #${channelName}`);
    return;
  }

  await sql`
    DELETE FROM channel_members WHERE channel_name = ${channelName} AND member_name = ${name}
  `;

  channel.members.delete(name);

  // Notify remaining connected members
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
  await addMessage(stored);

  // Send full message to the SENDER (so they see their own message)
  const senderWs = clients.get(from);
  if (senderWs) {
    send(senderWs, { type: "channel_message", channel: channelName, from, text, time });
  }

  // Send lightweight notification to OTHER currently-connected members (no content!)
  for (const member of channel.members) {
    if (member !== from) {
      const memberWs = clients.get(member);
      if (memberWs) {
        send(memberWs, { type: "channel_notification", channel: channelName });
      }
    }
  }
}

export async function readChannel(channelName: string, name: string, ws: Socket): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) {
    sendError(ws, `Channel #${channelName} does not exist`);
    return;
  }
  if (!channel.members.has(name)) {
    sendError(ws, `Not a member of #${channelName}`);
    return;
  }

  const history = await getChannelHistory(channelName);
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
