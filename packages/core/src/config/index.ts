import { z } from "zod";

/**
 * Validated, typed configuration for every runtime (api, worker, orchestrator).
 *
 * Each runtime parses only the slice it needs, once, at boot. Parsing fails fast
 * with a readable list of every missing or malformed variable, so a misconfigured
 * deployment never limps along on silent defaults. Defaults exist only where a
 * value is genuinely safe everywhere (timeouts, ladder tuning). Anything that
 * names infrastructure (buckets, endpoints, keys) is required.
 *
 * See docs/guides/configuration.md for the full reference.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number) => z.coerce.number().int().default(def);
const num = (def: number) => z.coerce.number().default(def);

/** Comma-separated list ("a,b,c") into a trimmed, non-empty string array. */
const list = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? def
        : v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
    );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/** Secrets must be long enough to be real. Placeholders shipped in examples fail in production. */
const secret = (name: string) =>
  z.string({ required_error: `${name} is required` }).min(32, `${name} must be at least 32 characters`);

const PLACEHOLDER = /change[-_]?me|example|placeholder|^x+$/i;

// ─── Core: shared by every runtime ───────────────────────────────────────────

const coreSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).optional(),
  /** Informational: which cloud this process targets. Drives nothing but log context. */
  EVS_CLOUD: z.enum(["floci", "aws"]).default("aws"),

  /** Static connection URL. Takes precedence over the secret-based settings below. */
  DATABASE_URL: z.string().url().optional(),
  /**
   * AWS: read the password from this RDS-managed secret for every new
   * connection, so password rotation needs no restart. Requires DB_HOST,
   * DB_NAME and DB_USER. See packages/core/src/db/connection-config.ts.
   */
  DATABASE_SECRET_ARN: optionalString,
  DB_HOST: optionalString,
  DB_PORT: int(5432),
  DB_NAME: optionalString,
  DB_USER: optionalString,
  DB_SSL: z.enum(["disable", "require", "verify-full"]).default("require"),
  DB_SSL_CA_FILE: optionalString,
  PG_POOL_MAX: z.coerce.number().int().positive().optional(),
  PG_POOL_MIN: int(0),
  PG_CONNECTION_TIMEOUT_MS: int(10_000),
  PG_IDLE_TIMEOUT_MS: int(10_000),
  PG_STATEMENT_TIMEOUT_MS: int(30_000),

  AWS_REGION: z.string().default("us-east-1"),
  /**
   * Standard AWS SDK override (honored natively by SDK v3). Set to the emulator
   * (http://floci:4566) for local runs; leave unset for real AWS.
   */
  AWS_ENDPOINT_URL: optionalString,
  /** Emulators and MinIO need path-style S3 addressing. */
  S3_FORCE_PATH_STYLE: bool(false),
  /**
   * Browser-reachable S3 endpoint used ONLY for presigning (upload POSTs and
   * presigned delivery). Inside Docker the API reaches the emulator as
   * http://floci:4566 but a browser must use http://localhost:4566, and SigV4
   * signs the host, so presigning needs its own client.
   */
  S3_PUBLIC_ENDPOINT: optionalString,

  UPLOADS_BUCKET: z.string({ required_error: "UPLOADS_BUCKET is required" }).min(3),
  MEDIA_BUCKET: z.string({ required_error: "MEDIA_BUCKET is required" }).min(3),
  DOWNLOADS_BUCKET: z.string({ required_error: "DOWNLOADS_BUCKET is required" }).min(3),

  /** KMS key (id, ARN or alias) that wraps content keys. Unset = local AES-256-GCM wrap. */
  KMS_KEY_ID: optionalString,
  /**
   * 32+ char secret used for local key wrapping (when KMS_KEY_ID is unset) and to
   * seal webhook signing secrets at rest. Sub-keys are derived per purpose with
   * HKDF, so one secret never serves two uses directly.
   */
  DATA_ENCRYPTION_KEY: secret("DATA_ENCRYPTION_KEY"),
});

// ─── API ─────────────────────────────────────────────────────────────────────

const apiSchema = z.object({
  PORT: int(8080),
  /** 0 = one cluster worker per CPU. */
  CLUSTER_WORKERS: int(1),
  /** Public base URL of this API, used to build tokenized key and playlist URLs. */
  PUBLIC_API_BASE: z.string({ required_error: "PUBLIC_API_BASE is required" }).url(),
  /** Exact origins allowed to call the management API from a browser (the console). */
  CORS_ALLOWED_ORIGINS: list(),
  TRUST_PROXY_HOPS: int(1),

  /** HMAC pepper for API key hashes. Rotating it invalidates every key. */
  API_KEY_PEPPER: secret("API_KEY_PEPPER"),
  /**
   * Playback token keyring: "kid1=secret1,kid2=secret2". Tokens are signed with
   * PLAYBACK_ACTIVE_KID and verified against any key in the ring, so a signing
   * key can be rotated with zero downtime (add new, switch active, drop old).
   */
  PLAYBACK_SIGNING_KEYS: z
    .string({ required_error: "PLAYBACK_SIGNING_KEYS is required" })
    .transform((v, ctx) => {
      const ring = new Map<string, string>();
      for (const pair of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = pair.indexOf("=");
        const kid = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (idx <= 0 || !/^[A-Za-z0-9_-]{1,32}$/.test(kid) || key.length < 32) {
          ctx.addIssue({ code: "custom", message: "entries must be kid=secret with a 32+ char secret" });
          return z.NEVER;
        }
        ring.set(kid, key);
      }
      if (ring.size === 0) {
        ctx.addIssue({ code: "custom", message: "at least one signing key is required" });
        return z.NEVER;
      }
      return ring;
    }),
  PLAYBACK_ACTIVE_KID: z.string({ required_error: "PLAYBACK_ACTIVE_KID is required" }),
  PLAYBACK_TOKEN_ISSUER: z.string().default("evs"),

  /**
   * How segment, poster and thumbnail URLs are produced (see apps/api/src/delivery):
   *   cloudfront-signed  private bucket behind CloudFront; signed policy per playlist (AWS)
   *   presigned          S3 presigned GET per object (emulators, MinIO, R2)
   *   proxy              the API streams objects itself after verifying the token
   *   public             unsigned public base URL (testing only)
   */
  DELIVERY_DRIVER: z.enum(["cloudfront-signed", "presigned", "proxy", "public"]).default("presigned"),
  MEDIA_PUBLIC_BASE: optionalString,
  CLOUDFRONT_KEY_PAIR_ID: optionalString,
  /** PEM private key for CloudFront signing. "\n" escapes are accepted. */
  CLOUDFRONT_PRIVATE_KEY: optionalString,

  MAX_UPLOAD_BYTES: num(20 * 1024 ** 3),
  /** Cap on not-yet-terminal videos, a backpressure guard against upload floods. */
  MAX_IN_FLIGHT: int(50),
  RATE_LIMIT_PER_MINUTE: int(600),
  PLAYBACK_RATE_LIMIT_PER_MINUTE: int(3000),
  WEBHOOK_DISPATCH_ENABLED: bool(true),
  WEBHOOK_TIMEOUT_MS: int(10_000),
  /**
   * LOCAL DEMOS ONLY. Lets webhooks target private / in-network addresses (and
   * plain http) while NODE_ENV=production, so the compose stack can deliver to
   * a receiver container. Refused when EVS_CLOUD=aws: real deployments always
   * keep the SSRF guard on.
   */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool(false),
});

// ─── Worker ──────────────────────────────────────────────────────────────────

const workerSchema = z.object({
  /**
   * Which queue(s) this worker services:
   *   all      claim videos, then background jobs (single-pool deployments)
   *   primary  claim uploaded videos only (the large transcode pool)
   *   jobs     claim background jobs (captions, download MP4) only (the small pool)
   */
  WORKER_MODE: z.enum(["all", "primary", "jobs"]).default("all"),
  WORKER_ID: optionalString,
  /** "ec2" reads instance identity + Spot notices from IMDSv2; "local" skips both. */
  WORKER_PLATFORM: z.enum(["ec2", "local"]).default("ec2"),
  IDLE_GRACE_MS: int(120_000),
  POLL_MS: int(5_000),
  HEARTBEAT_MS: int(30_000),
  /** When true (default) the worker logs instead of shutting the host down when idle. */
  WORKER_DRY_RUN_SHUTDOWN: bool(true),
  WORK_DIR: z.string().default("/tmp/evs"),

  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),
  WHISPER_BIN: z.string().default("/opt/whisper.cpp/whisper-cli"),
  WHISPER_MODEL: z.string().default("/opt/models/ggml-small.bin"),
  CAPTIONS_ENABLED: bool(true),
  CAPTIONS_DEFAULT_LANG: z.string().default("en"),

  // Streaming ladder levers (tunable without rebuilding the worker image).
  LADDER_PRESET: z.string().default("medium"),
  LADDER_CRF: int(19),
  CAP_TO_SOURCE: bool(true),
  CAP_TO_SOURCE_FACTOR: num(1.1),
  CAP_TO_SOURCE_FLOOR: num(0.6),
  MIN_OUTPUT_FPS: int(24),

  // Downloadable MP4 (a size-conscious re-encode, not a copy of the top rung).
  DOWNLOAD_ENABLED: bool(true),
  DOWNLOAD_VIDEO_CODEC: z.enum(["libx264", "libx265"]).default("libx264"),
  DOWNLOAD_CRF: z.string().default("23"),
  DOWNLOAD_PRESET: z.string().default("medium"),
  DOWNLOAD_MAXRATE_KBPS: int(2800),
});

// ─── Orchestrator ────────────────────────────────────────────────────────────

const orchestratorSchema = z.object({
  /** "ec2-spot" launches EC2 Fleet capacity; "noop" only logs decisions (local/demo). */
  LAUNCHER: z.enum(["ec2-spot", "noop"]).default("ec2-spot"),
  /** Local loop interval when not running inside Lambda. */
  ORCHESTRATOR_INTERVAL_MS: int(60_000),
  MAX_WORKERS: int(20),
  /** Queued videos per worker. 1 = one worker per queued video, up to MAX_WORKERS. */
  DIVISOR: int(1),
  LAUNCH_TEMPLATE_NAME: optionalString,
  LAUNCH_TEMPLATE_VERSION: z.string().default("$Latest"),
  /** Subnets to fan out across (one per AZ) so one AZ running dry can't stall the fleet. */
  WORKER_SUBNET_IDS: list(),
  /**
   * Strict preference ladder, highest first. Each type is tried across every AZ
   * before the next. All entries must match the worker AMI's architecture.
   */
  WORKER_INSTANCE_TYPES: list(["c7g.4xlarge", "c7g.2xlarge", "c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]),
  WORKER_ROLE_TAG: z.string().default("evs-transcoder"),
  SPOT_ALLOCATION_STRATEGY: z
    .enum(["capacity-optimized", "price-capacity-optimized", "lowest-price", "diversified"])
    .default("price-capacity-optimized"),
  ONDEMAND_FALLBACK: bool(false),

  // Optional second, smaller pool for background jobs. Empty = single pool.
  JOBS_LAUNCH_TEMPLATE_NAME: optionalString,
  JOBS_INSTANCE_TYPES: list(["c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]),
  JOBS_ROLE_TAG: z.string().default("evs-transcoder-jobs"),
  JOBS_MAX_WORKERS: int(10),
});

export type CoreConfig = z.infer<typeof coreSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type OrchestratorConfig = z.infer<typeof orchestratorSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const parse = <S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> => {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
};

const memo = <T>(fn: () => T): (() => T) => {
  let cached: T | undefined;
  return () => (cached ??= fn());
};

/** Refuse obviously-placeholder secrets outside development. */
const assertProductionSecrets = (env: NodeJS.ProcessEnv, names: string[]): void => {
  if ((env.NODE_ENV ?? "development") !== "production") return;
  const bad = names.filter((n) => env[n] && PLACEHOLDER.test(env[n] as string));
  if (bad.length) throw new ConfigError(bad.map((n) => `${n}: placeholder value not allowed in production`));
};

export const getCoreConfig = memo(() => {
  assertProductionSecrets(process.env, ["DATA_ENCRYPTION_KEY"]);
  const cfg = parse(coreSchema, process.env);
  if (!cfg.DATABASE_URL) {
    const issues: string[] = [];
    if (!cfg.DATABASE_SECRET_ARN) {
      issues.push("DATABASE_URL: required unless DATABASE_SECRET_ARN (with DB_HOST, DB_NAME, DB_USER) is set");
    } else {
      for (const k of ["DB_HOST", "DB_NAME", "DB_USER"] as const) {
        if (!cfg[k]) issues.push(`${k}: required when DATABASE_SECRET_ARN is set`);
      }
    }
    if (cfg.DB_SSL === "verify-full" && !cfg.DB_SSL_CA_FILE) issues.push("DB_SSL_CA_FILE: required for DB_SSL=verify-full");
    if (issues.length) throw new ConfigError(issues);
  }
  return { ...cfg, isProduction: cfg.NODE_ENV === "production" };
});

export const getApiConfig = memo(() => {
  assertProductionSecrets(process.env, ["API_KEY_PEPPER", "PLAYBACK_SIGNING_KEYS"]);
  const cfg = parse(apiSchema, process.env);
  const issues: string[] = [];
  if (!cfg.PLAYBACK_SIGNING_KEYS.has(cfg.PLAYBACK_ACTIVE_KID)) {
    issues.push("PLAYBACK_ACTIVE_KID: must name a key present in PLAYBACK_SIGNING_KEYS");
  }
  if (cfg.DELIVERY_DRIVER === "cloudfront-signed") {
    if (!cfg.MEDIA_PUBLIC_BASE) issues.push("MEDIA_PUBLIC_BASE: required for cloudfront-signed delivery");
    if (!cfg.CLOUDFRONT_KEY_PAIR_ID) issues.push("CLOUDFRONT_KEY_PAIR_ID: required for cloudfront-signed delivery");
    if (!cfg.CLOUDFRONT_PRIVATE_KEY) issues.push("CLOUDFRONT_PRIVATE_KEY: required for cloudfront-signed delivery");
  }
  if (cfg.WEBHOOK_ALLOW_PRIVATE_TARGETS && process.env.EVS_CLOUD === "aws") {
    issues.push("WEBHOOK_ALLOW_PRIVATE_TARGETS: not allowed when EVS_CLOUD=aws (local demos only)");
  }
  if (cfg.DELIVERY_DRIVER === "public" && !cfg.MEDIA_PUBLIC_BASE) {
    issues.push("MEDIA_PUBLIC_BASE: required for public delivery");
  }
  if (issues.length) throw new ConfigError(issues);
  return {
    ...cfg,
    PUBLIC_API_BASE: cfg.PUBLIC_API_BASE.replace(/\/+$/, ""),
    MEDIA_PUBLIC_BASE: cfg.MEDIA_PUBLIC_BASE?.replace(/\/+$/, ""),
    CLOUDFRONT_PRIVATE_KEY: cfg.CLOUDFRONT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
});

export const getWorkerConfig = memo(() => parse(workerSchema, process.env));

export const getOrchestratorConfig = memo(() => {
  const cfg = parse(orchestratorSchema, process.env);
  if (cfg.LAUNCHER === "ec2-spot") {
    const issues: string[] = [];
    if (!cfg.LAUNCH_TEMPLATE_NAME) issues.push("LAUNCH_TEMPLATE_NAME: required for the ec2-spot launcher");
    if (cfg.WORKER_SUBNET_IDS.length === 0) issues.push("WORKER_SUBNET_IDS: required for the ec2-spot launcher");
    if (issues.length) throw new ConfigError(issues);
  }
  return cfg;
});
