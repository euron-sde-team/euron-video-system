import type { NextFunction, Request, Response } from "express";
import { AppError, UnauthorizedError } from "@evs/core/errors";
import { playbackDenials } from "../metrics.js";
import playbackService from "../services/playback.service.js";
import { extractBearer } from "./auth.middleware.js";

/**
 * Playback-token authentication for every /v1/play route.
 *
 * The token arrives as `?token=` (required for native Apple HLS, whose
 * EXT-X-KEY and variant URIs cannot carry headers) or as a Bearer header
 * (hls.js can do either). The verified context lands on res.locals.delivery.
 */
export const requirePlaybackToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = (typeof req.query.token === "string" && req.query.token) || extractBearer(req);
  try {
    if (!token) throw new UnauthorizedError("Playback token required");
    const videoId = String(req.params.videoId ?? "");
    res.locals.delivery = await playbackService.verifyForDelivery(token, videoId, req.get("origin"));
  } catch (err) {
    playbackDenials.inc({ reason: err instanceof AppError ? err.code : "error" });
    throw err;
  }
  // Every playback response carries a per-viewer token or key: never cache.
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
};
