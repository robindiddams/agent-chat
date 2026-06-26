/**
 * run-sql.ts — execute a SQL file against the provisioned Postgres.
 *
 * Usage:
 *   bun run scripts/run-sql.ts                  # defaults to ../db/schema.sql
 *   bun run scripts/run-sql.ts path/to/file.sql
 *
 * DATABASE_URL is read from the environment (Bun auto-loads .env from cwd).
 * The connection string is NEVER printed.
 */
import { SQL } from "bun";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlFile = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, "..", "db", "schema.sql");

// ── Validate env ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Check packages/server/.env");
  process.exit(1);
}

const sql = new SQL(process.env.DATABASE_URL!);

async function main() {
  let fileText: string;
  try {
    fileText = readFileSync(sqlFile, "utf-8");
  } catch (err) {
    console.error(`ERROR: could not read SQL file: ${sqlFile}`);
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(`Applying: ${sqlFile}`);

  // Bun.sql's unsafe() supports multi-statement strings (simple query protocol).
  await sql.unsafe(fileText);

  console.log("SQL applied successfully.\n");

  // Verify: list public tables
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

  console.log("Public tables:");
  if (tables.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of tables) {
      console.log(`  - ${row.table_name}`);
    }
  }

  await sql.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration FAILED:");
  // Print the error message but scrub any connection string that might appear.
  const msg = (err as Error).message?.replace(
    /postgres:\/\/[^\s]+/g,
    "postgres://<redacted>"
  );
  console.error(msg);
  sql.close().finally(() => process.exit(1));
});
