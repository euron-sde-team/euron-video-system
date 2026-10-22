import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { getApiConfig } from "@evs/core/config";
import { TooManyRequestsError } from "@evs/core/errors";

/**
 * Fixed-window rate limits (in-memory, per process).
 *
 * Per API key for the management API: one noisy integration cannot starve the
 * others. Per client IP for playback, where there is no key. The memory store
 * is per process, so the effective limit scales with instance count; swap in a
 * shared store (Redis) if exact global limits matter for your deployment.
 */
const handler = (_req: Request, _res: unknown, next: (err?: unknown) => void): void =>
  next(new TooManyRequestsError("Rate limit exceeded; retry after the window resets"));

export const managementRateLimit = (): RequestHandler =>
  rateLimit({
    windowMs: 60_000,
    limit: getApiConfig().RATE_LIMIT_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => (req.auth ? `key:${req.auth.apiKeyId}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`),
    handler,
  });

export const playbackRateLimit = (): RequestHandler =>
  rateLimit({
    windowMs: 60_000,
    limit: getApiConfig().PLAYBACK_RATE_LIMIT_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
    handler,
  });
