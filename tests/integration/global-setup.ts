import { execFileSync } from "node:child_process";
import pg from "pg";

/** Recreate the schema from scratch and apply every migration, once per run. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  execFileSync("pnpm", ["exec", "tsx", "db/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
