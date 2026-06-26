// ── Client → Server ──────────────────────────────────

export type JoinMessage = { type: "join"; name: string; token?: string };
export type ChatMessage = { type: "message"; text: string };
export type DmMessage = { type: "dm"; to: string; text: string };
export type CreateChannelMessage = { type: "create_channel"; channel: string };
export type JoinChannelMessage = { type: "join_channel"; channel: string };
export type LeaveChannelMessage = { type: "leave_channel"; channel: string };
export type ChannelChatMessage = { type: "channel_message"; channel: string; text: string };
export type ReadChannelMessage = { type: "read_channel"; channel: string };
export type ListChannelsMessage = { type: "list_channels" };

export type ClientMessage =
  | JoinMessage
  | ChatMessage
  | DmMessage
  | CreateChannelMessage
  | JoinChannelMessage
  | LeaveChannelMessage
  | ChannelChatMessage
  | ReadChannelMessage
  | ListChannelsMessage;

// ── Server → Client ──────────────────────────────────

export type JoinedEvent = { type: "joined"; name: string; names: string[] };
export type LeftEvent = { type: "left"; name: string };
export type MessageEvent = { type: "message"; from: string; text: string; time: number };
export type DmEvent = { type: "dm"; from: string; text: string; time: number };
export type HistoryEvent = { type: "history"; messages: StoredMessage[] };
export type ErrorEvent = { type: "error"; message: string };
export type ChannelCreatedEvent = { type: "channel_created"; channel: string; by: string };
export type ChannelJoinedEvent = { type: "channel_joined"; channel: string; name: string; members: string[] };
export type ChannelLeftEvent = { type: "channel_left"; channel: string; name: string };
export type ChannelMessageEvent = { type: "channel_message"; channel: string; from: string; text: string; time: number };
export type ChannelNotificationEvent = { type: "channel_notification"; channel: string };
export type ChannelMessagesEvent = { type: "channel_messages"; channel: string; messages: StoredMessage[] };
export type ChannelsListEvent = { type: "channels_list"; channels: ChannelInfo[] };
export type ShutdownEvent = { type: "shutdown" };

export type ServerMessage =
  | JoinedEvent
  | LeftEvent
  | MessageEvent
  | DmEvent
  | HistoryEvent
  | ErrorEvent
  | ChannelCreatedEvent
  | ChannelJoinedEvent
  | ChannelLeftEvent
  | ChannelMessageEvent
  | ChannelNotificationEvent
  | ChannelMessagesEvent
  | ChannelsListEvent
  | ShutdownEvent;

// ── Helper types ─────────────────────────────────────

export type ChannelInfo = { name: string; members: string[] };

// ── Stored on disk ───────────────────────────────────

export type StoredMessage = {
  type: "message" | "dm" | "channel_message";
  from: string;
  text: string;
  time: number;
  to?: string;       // present for DMs
  channel?: string;   // present for channel messages
};
