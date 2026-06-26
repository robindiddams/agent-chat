import { SQL } from "bun";

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Check packages/server/.env");
  process.exit(1);
}

/** Shared Postgres client. Bun auto-loads packages/server/.env from cwd. */
export const sql = new SQL(process.env.DATABASE_URL);
