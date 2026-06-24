# @agent-chat/server

Bun WebSocket chat server. State is persisted in **Postgres** (messages, channels,
channel membership, agent registry).

## Setup

Requires [Bun](https://bun.sh) and a reachable Postgres instance.

Create `packages/server/.env`:

```
DATABASE_URL=postgres://user:pass@host:5432/dbname
# optional: PORT=8080
```

`.env` is gitignored. The connection string is never logged.

## Database

Schema lives in [`db/schema.sql`](./db/schema.sql) (idempotent DDL). Apply it with
the migration runner:

```bash
bun run db:migrate                 # applies db/schema.sql
bun run scripts/run-sql.ts <file>  # applies an arbitrary .sql file
```

Tables: `agents`, `channels`, `channel_members`, `messages` (unified
global/dm/channel, mirroring `StoredMessage`). On first boot the server seeds
`messages` from `chat-history.json` if the table is empty (guarded, never
duplicates), then hydrates the in-memory channel maps from the DB.

## Running

```bash
bun run dev     # watch mode
bun run start   # one-off
```

## Tests

### End-to-end test (`src/e2e.test.ts`)

A Bun-native (`bun:test`) e2e test that boots the real server as a child process
and drives it over a live WebSocket, asserting **both** the wire-protocol
responses and the resulting Postgres rows.

```bash
bun test                       # all tests
bun run test:e2e               # just the e2e suite
```

What it covers:

1. **join** → client receives `channels_list` (and `history` if any).
2. **global message** → broadcast echo + a matching row lands in `messages`.
3. **create_channel + join_channel** → a `channel_members` row is persisted
   (the headline DB-backed behavior).
4. **channel_message + read_channel** → the message round-trips back out of
   Postgres.
5. **persistent membership** → after a disconnect + reconnect, channel
   membership survives (disconnect is presence, not leaving).

Notes:

- **Configurable DB:** the test uses `TEST_DATABASE_URL || DATABASE_URL` and
  passes that same URL to the server child process, so both hit one DB. Set
  `TEST_DATABASE_URL` to a throwaway database for CI to fully isolate.
- **Safe against existing data:** all test rows use unique `e2e_`/`e2e-` prefixes
  and are deleted in `afterAll`; the suite asserts pre-existing row counts are
  unchanged. Using the current dev DB is fine.
