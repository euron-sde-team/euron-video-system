import cluster from "node:cluster";
import { Kysely, PostgresDialect, type Selectable, type Transaction } from "kysely";
import pg from "pg";
import { getCoreConfig } from "../config/index.js";
import logger from "../logger.js";
import { resolveConnectionConfig } from "./connection-config.js";
import type { DB } from "./types.js";

export type * from "./types.js";
export type Trx = Transaction<DB>;
export type Row<T extends keyof DB> = Selectable<DB[T]>;

// ─── UTC safety (read AND write) ─────────────────────────────────────────────
// `timestamp without time zone` (oid 1114) is parsed as UTC, and every entry
// point sets TZ=UTC before importing anything, because pg serializes Date
// objects with local getters. Without both, writes use local time while reads
// assume UTC and every timestamp shifts by the host's offset. The schema uses
// timestamptz throughout; this is a guard for anything that is not.
pg.types.setTypeParser(1114, (val: string) => new Date(`${val}+00`));

/** pg BIGINT / SUM() arrive as strings. Parse before arithmetic. */
export const toNumber = (v: unknown): number =>
  v === null || v === undefined ? 0 : typeof v === "string" ? parseInt(v, 10) : Number(v);

export const toNullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : toNumber(v);

let instance: { pool: pg.Pool; db: Kysely<DB> } | null = null;

/**
 * Lazily-created pool + Kysely instance. One pool per process: the API runs
 * one per cluster worker, a transcode worker runs one small pool. Size the RDS
 * max_connections for (API tasks x cluster workers x PG_POOL_MAX) + workers.
 */
const init = (): { pool: pg.Pool; db: Kysely<DB> } => {
  if (instance) return instance;
  const cfg = getCoreConfig();
  const label = cluster.isWorker && cluster.worker ? `w${cluster.worker.id}` : "main";

  const pool = new pg.Pool({
    // DATABASE_URL, or per-connection password resolution from Secrets Manager
    // so RDS password rotation takes effect without a restart.
    ...resolveConnectionConfig(process.env),
    application_name: `${process.env.EVS_SERVICE ?? "evs"}-${label}-${process.pid}`,
    keepAlive: true,
    max: cfg.PG_POOL_MAX ?? (cfg.isProduction ? 8 : 10),
    min: cfg.PG_POOL_MIN,
    connectionTimeoutMillis: cfg.PG_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: cfg.PG_IDLE_TIMEOUT_MS,
    statement_timeout: cfg.PG_STATEMENT_TIMEOUT_MS,
    // A leaked BEGIN must never pin a connection forever.
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on("error", (err) => logger.error("pg pool idle client error", { err: err.message }));

  instance = { pool, db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }) };
  return instance;
};

/** The shared Kysely instance. */
export const getDb = (): Kysely<DB> => init().db;
export const getPool = (): pg.Pool => init().pool;

/** Probe the database at boot with exponential backoff (survives an RDS failover). */
export const waitForDatabase = async (attempts = 6, baseDelayMs = 500): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    try {
      await getPool().query("SELECT 1");
      logger.info(i === 0 ? "database connected" : `database connected after ${i + 1} attempts`);
      return;
    } catch (err) {
      const delay = baseDelayMs * 2 ** i;
      logger.warn(`database connect attempt ${i + 1}/${attempts} failed; retrying in ${delay}ms`, {
        err: (err as Error).message,
      });
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("database connection failed");
};

/** Drain the pool from SIGTERM/SIGINT handlers. */
export const closeDatabase = async (): Promise<void> => {
  if (!instance) return;
  const { db } = instance;
  instance = null;
  await db.destroy().catch((err) => logger.error("error closing database pool", { err: String(err) }));
};
