import { sql } from "./db";
import { existsSync, readFileSync } from "fs";
import type { StoredMessage } from "./protocol";

// ── Row → StoredMessage ──────────────────────────────

interface MessageRow {
  id: number;
  kind: "message" | "dm" | "channel_message";
  sender_name: string;
  body: string;
  recipient_name: string | null;
  channel_name: string | null;
  time_ms: string; // bigint comes back as string
}

function rowToStored(r: MessageRow): StoredMessage {
  const msg: StoredMessage = {
    type: r.kind,
    from: r.sender_name,
    text: r.body,
    time: Number(r.time_ms),
  };
  if (r.kind === "dm" && r.recipient_name) {
    msg.to = r.recipient_name;
  }
  if (r.kind === "channel_message" && r.channel_name) {
    msg.channel = r.channel_name;
  }
  return msg;
}

// ── CRUD ─────────────────────────────────────────────

export async function addMessage(msg: StoredMessage): Promise<void> {
  await sql`
    INSERT INTO messages (kind, sender_name, body, recipient_name, channel_name, time_ms)
    VALUES (${msg.type}, ${msg.from}, ${msg.text}, ${msg.to ?? null}, ${msg.channel ?? null}, ${msg.time})
  `;
}

/** Get messages relevant to a specific user (global + their DMs both directions) */
export async function getHistoryFor(name: string): Promise<StoredMessage[]> {
  const rows = await sql<MessageRow[]>`
    SELECT id, kind, sender_name, body, recipient_name, channel_name, time_ms
    FROM messages
    WHERE kind = 'message'
       OR sender_name = ${name}
       OR recipient_name = ${name}
    ORDER BY time_ms, id
  `;
  return rows.map(rowToStored);
}

/** Get all messages for a specific channel */
export async function getChannelHistory(channel: string): Promise<StoredMessage[]> {
  const rows = await sql<MessageRow[]>`
    SELECT id, kind, sender_name, body, recipient_name, channel_name, time_ms
    FROM messages
    WHERE kind = 'channel_message' AND channel_name = ${channel}
    ORDER BY time_ms, id
  `;
  return rows.map(rowToStored);
}

// ── One-time seed from chat-history.json ──────────────

/**
 * If the messages table is empty AND chat-history.json exists,
 * import its records. Guarded so re-running never duplicates.
 */
export async function seedFromJson(): Promise<void> {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM messages`;
  if (n > 0) {
    console.log(`Seed skipped — messages table already has ${n} rows.`);
    return;
  }

  const file = "chat-history.json";
  if (!existsSync(file)) {
    console.log("Seed skipped — no chat-history.json found.");
    return;
  }

  let records: StoredMessage[];
  try {
    records = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    console.warn(`Seed: failed to parse ${file}:`, e);
    return;
  }

  if (records.length === 0) {
    console.log("Seed skipped — chat-history.json is empty.");
    return;
  }

  // Collect unique channel names from the history and insert them first
  // (messages.channel_name has an FK to channels.name).
  const channelNames = [...new Set(
    records.filter((r) => r.type === "channel_message" && r.channel).map((r) => r.channel!)
  )];
  if (channelNames.length > 0) {
    for (const name of channelNames) {
      await sql`
        INSERT INTO channels (name, created_by) VALUES (${name}, ${"seed"})
        ON CONFLICT (name) DO NOTHING
      `;
    }
    console.log(`Seed: created ${channelNames.length} channels (${channelNames.join(", ")}).`);
  }

  // Build a parameterized multi-row INSERT via unsafe().
  // Bun.sql tagged templates don't expand arrays for VALUES in this version.
  const params: (string | number | null)[] = [];
  const tuples = records.map((r) => {
    const vals = [r.type, r.from, r.text, r.to ?? null, r.channel ?? null, r.time] as const;
    const ph = vals
      .map((v) => {
        params.push(v as string | number | null);
        return `$${params.length}`;
      })
      .join(", ");
    return `(${ph})`;
  });

  await sql.unsafe(
    `INSERT INTO messages (kind, sender_name, body, recipient_name, channel_name, time_ms) VALUES ${tuples.join(", ")}`,
    params
  );

  console.log(`Seed complete — imported ${records.length} messages from ${file}.`);
}
