import type { NextFunction, Request, Response } from "express";
import { getApiConfig } from "@evs/core/config";

/**
 * Management-API CORS: an explicit allowlist (CORS_ALLOWED_ORIGINS, normally
 * just the operator console). No credentials mode: auth is a bearer header,
 * never a cookie, so there is nothing ambient for a hostile page to ride on.
 * Unlisted origins get no CORS headers at all and the browser blocks them.
 */
export const managementCors = (req: Request, res: Response, next: NextFunction): void => {
  const origin = req.get("origin");
  if (origin && getApiConfig().CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, RateLimit, RateLimit-Policy, Retry-After");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};

/**
 * Playback CORS: players are embedded on customer sites, so the browser-level
 * CORS answer is permissive ("*", no credentials). The REAL origin check is
 * server-side, per playback policy, in playbackService.verifyForDelivery; a
 * disallowed origin gets a 403 regardless of what CORS says.
 */
export const playbackCors = (req: Request, res: Response, next: NextFunction): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Range");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};
