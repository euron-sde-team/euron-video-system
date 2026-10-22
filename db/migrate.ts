/**
 * Minimal forward-only migration runner.
 *
 * Applies every db/migrations/NNNN_*.sql file that is not yet recorded in
 * schema_migrations, in filename order, each inside its own transaction. A
 * Postgres advisory lock makes concurrent runs (two API tasks booting at once)
 * safe: the second waits, then finds nothing left to apply.
 *
 *   pnpm db:migrate            apply pending migrations
 *   pnpm db:migrate --status   list applied / pending without changing anything
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveConnectionConfig } from "../packages/core/src/db/connection-config.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_ID = 727_001; // arbitrary, stable advisory-lock key for this runner

const main = async (): Promise<void> => {
  const statusOnly = process.argv.includes("--status");
  // DATABASE_URL, or DATABASE_SECRET_ARN + DB_* (the RDS-managed secret on AWS).
  const client = new pg.Client(resolveConnectionConfig(process.env));
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum]
      )
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

    for (const file of files) {
      const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sqlText).digest("hex");
      const prior = applied.get(file);

      if (prior) {
        // An applied migration must never be edited; add a new one instead.
        if (prior !== checksum) throw new Error(`${file} changed after it was applied`);
        console.log(`  applied  ${file}`);
        continue;
      }
      if (statusOnly) {
        console.log(`  pending  ${file}`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
        console.log(`  migrated ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
