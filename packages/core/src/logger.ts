import { createLogger, format, transports, type Logger } from "winston";

/**
 * Process-wide structured logger.
 *
 * Production emits one JSON object per line (CloudWatch Logs Insights, Loki and
 * friends parse it without configuration). Development emits a readable single
 * line. The logger reads NODE_ENV/LOG_LEVEL directly rather than through the
 * validated config so it is usable before (and while reporting) a config error.
 */
const isProduction = process.env.NODE_ENV === "production";

const devFormat = format.printf(({ timestamp, level, message, service, stack, ...rest }) => {
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  const base = `${timestamp} ${level.toUpperCase().padEnd(5)} [${service}] ${message}${extra}`;
  return stack ? `${base}\n${stack}` : base;
});

const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  defaultMeta: { service: process.env.EVS_SERVICE ?? "evs" },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    isProduction ? format.json() : devFormat
  ),
  transports: [new transports.Console()],
  // Tests assert on behavior, not log lines. EVS_TEST_LOGS=1 brings them back when debugging.
  silent: (process.env.NODE_ENV === "test" || Boolean(process.env.VITEST)) && !process.env.EVS_TEST_LOGS,
});

/** Keys that must never reach a log line, wherever they appear in a payload. */
const REDACT = new Set(["password", "secret", "token", "authorization", "apiKey", "api_key", "privateKey", "wrappedKey"]);

/** Deep-copy a value with sensitive keys masked. Safe on cycles and odd shapes. */
export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.has(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
};

export default logger;
