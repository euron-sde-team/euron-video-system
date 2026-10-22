import { Router } from "express";
import * as control from "../controllers/control.controller.js";
import * as play from "../controllers/play.controller.js";
import * as videos from "../controllers/videos.controller.js";
import { asyncHandler as h } from "../http/async-handler.js";
import { requireApiKey, requireScope } from "../middlewares/auth.middleware.js";
import { managementCors, playbackCors } from "../middlewares/cors.middleware.js";
import { requirePlaybackToken } from "../middlewares/playback-auth.middleware.js";
import { managementRateLimit, playbackRateLimit } from "../middlewares/rate-limit.middleware.js";

/**
 * /v1 surface. Two audiences, two auth models:
 *
 *   /v1/play/**   viewers' players, playback token (?token= or Bearer)
 *   everything else  integrating backends and the console, scoped API key
 *
 * The playback router is mounted FIRST so its permissive CORS and per-IP rate
 * limit never mix with the management API's allowlist and per-key limit.
 */
export const createV1Router = (): Router => {
  const v1 = Router();

  // ─── Playback (token-gated) ────────────────────────────────────────────
  const playRouter = Router({ mergeParams: true });
  playRouter.use(playbackCors, playbackRateLimit(), h(requirePlaybackToken));
  playRouter.get("/master.m3u8", h(play.getMaster));
  playRouter.get("/key", h(play.getKey));
  playRouter.get("/thumbnails.vtt", h(play.getThumbnails));
  playRouter.get("/poster.jpg", h(play.getPoster));
  playRouter.get("/media/*path", h(play.getMediaObject));
  // Registered last so the literal routes above are never captured as a rung.
  playRouter.get("/:rung/index.m3u8", h(play.getVariant));
  v1.use("/play/:videoId", playRouter);

  // ─── Management (API key) ──────────────────────────────────────────────
  const api = Router();
  api.use(managementCors, h(requireApiKey), managementRateLimit());

  api.get("/me", h(control.getMe));
  api.get("/stats", requireScope("videos:read"), h(videos.getStats));

  api.post("/videos", requireScope("videos:write"), h(videos.createVideo));
  api.get("/videos", requireScope("videos:read"), h(videos.listVideos));
  api.get("/videos/:id", requireScope("videos:read"), h(videos.getVideo));
  api.patch("/videos/:id", requireScope("videos:write"), h(videos.updateVideo));
  api.delete("/videos/:id", requireScope("videos:write"), h(videos.deleteVideo));
  api.post("/videos/:id/complete", requireScope("videos:write"), h(videos.completeUpload));
  api.post("/videos/:id/retry", requireScope("videos:write"), h(videos.retryVideo));
  api.post("/videos/:id/cancel", requireScope("videos:write"), h(videos.cancelVideo));
  api.get("/videos/:id/download", requireScope("videos:read"), h(videos.getDownload));
  api.post("/videos/:id/playback-sessions", requireScope("playback:mint"), h(videos.mintPlaybackSession));

  api.get("/playback-sessions", requireScope("playback:mint"), h(control.listSessions));
  api.delete("/playback-sessions/:id", requireScope("playback:mint"), h(control.revokeSession));

  api.get("/playback-policies", requireScope("videos:read"), h(control.listPolicies));
  api.post("/playback-policies", requireScope("policies:manage"), h(control.createPolicy));
  api.get("/playback-policies/:id", requireScope("videos:read"), h(control.getPolicy));
  api.patch("/playback-policies/:id", requireScope("policies:manage"), h(control.updatePolicy));
  api.delete("/playback-policies/:id", requireScope("policies:manage"), h(control.deletePolicy));

  api.get("/api-keys", requireScope("keys:manage"), h(control.listApiKeys));
  api.post("/api-keys", requireScope("keys:manage"), h(control.createApiKey));
  api.delete("/api-keys/:id", requireScope("keys:manage"), h(control.revokeApiKey));

  api.get("/webhooks", requireScope("webhooks:manage"), h(control.listWebhooks));
  api.post("/webhooks", requireScope("webhooks:manage"), h(control.createWebhook));
  api.get("/webhooks/:id", requireScope("webhooks:manage"), h(control.getWebhook));
  api.patch("/webhooks/:id", requireScope("webhooks:manage"), h(control.updateWebhook));
  api.delete("/webhooks/:id", requireScope("webhooks:manage"), h(control.deleteWebhook));
  api.post("/webhooks/:id/test", requireScope("webhooks:manage"), h(control.testWebhook));
  api.get("/webhooks/:id/deliveries", requireScope("webhooks:manage"), h(control.listDeliveries));
  api.post("/webhook-deliveries/:id/redeliver", requireScope("webhooks:manage"), h(control.redeliver));

  api.get("/audit-events", requireScope("audit:read"), h(control.listAuditEvents));
  api.get("/usage", requireScope("usage:read"), h(control.getUsage));

  v1.use(api);
  return v1;
};
