import type { Request, Response } from "express";
import { z } from "zod";
import { page, paginationQuery } from "../http/pagination.js";
import { body, param, query } from "../http/validate.js";
import { actorOf, hashIp } from "../services/actor.js";
import auditService from "../services/audit.service.js";
import playbackService from "../services/playback.service.js";
import videosService from "../services/videos.service.js";

const STATUSES = ["uploading", "uploaded", "processing", "ready", "failed", "cancelled"] as const;
const metadataSchema = z.record(z.unknown()).refine((m) => JSON.stringify(m).length <= 16_384, "metadata must be <= 16KB");

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    filename: z.string().trim().min(1).max(500),
    externalRef: z.string().trim().max(200).nullish(),
    metadata: metadataSchema.optional(),
    playbackPolicyId: z.string().max(64).nullish(),
    captions: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    externalRef: z.string().trim().max(200).nullable().optional(),
    metadata: metadataSchema.optional(),
    playbackPolicyId: z.string().max(64).nullable().optional(),
  })
  .strict();

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  ...paginationQuery,
});

const mintSchema = z
  .object({
    viewerId: z.string().trim().min(1).max(200),
    ttlSeconds: z.number().int().min(10).max(86_400).optional(),
    origin: z.string().url().max(500).optional(),
  })
  .strict();

export const createVideo = async (req: Request, res: Response) => {
  const input = body(req, createSchema);
  const result = await videosService.create(input);
  await auditService.record(actorOf(req), "video.create", { type: "video", id: result.video.id }, { title: input.title });
  res.status(201).json(result);
};

export const listVideos = async (req: Request, res: Response) => {
  const q = query(req, listSchema);
  const { rows, total } = await videosService.list(q);
  res.json(page(rows, q.page, q.limit, total));
};

export const getVideo = async (req: Request, res: Response) => {
  res.json(await videosService.get(param(req, "id")));
};

export const updateVideo = async (req: Request, res: Response) => {
  const patch = body(req, updateSchema);
  const id = param(req, "id");
  const video = await videosService.update(id, patch);
  await auditService.record(actorOf(req), "video.update", { type: "video", id }, { fields: Object.keys(patch) });
  res.json(video);
};

export const completeUpload = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const video = await videosService.complete(id);
  await auditService.record(actorOf(req), "video.complete_upload", { type: "video", id }, { sourceBytes: video.sourceBytes });
  res.json(video);
};

export const retryVideo = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const video = await videosService.retry(id);
  await auditService.record(actorOf(req), "video.retry", { type: "video", id });
  res.json(video);
};

export const cancelVideo = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const video = await videosService.cancel(id);
  await auditService.record(actorOf(req), "video.cancel", { type: "video", id });
  res.json(video);
};

export const deleteVideo = async (req: Request, res: Response) => {
  const id = param(req, "id");
  await videosService.delete(id);
  await auditService.record(actorOf(req), "video.delete", { type: "video", id });
  res.status(204).end();
};

export const getDownload = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const result = await videosService.downloadUrl(id);
  await auditService.record(actorOf(req), "video.download_url", { type: "video", id });
  res.json(result);
};

export const getStats = async (_req: Request, res: Response) => {
  res.json(await videosService.stats());
};

export const mintPlaybackSession = async (req: Request, res: Response) => {
  const input = body(req, mintSchema);
  const id = param(req, "id");
  const session = await playbackService.mint(id, input, {
    ipHash: hashIp(req.ip),
    userAgent: req.get("user-agent") ?? null,
  });
  await auditService.record(
    actorOf(req),
    "playback_session.create",
    { type: "playback_session", id: session.sessionId },
    { videoId: id, viewerId: input.viewerId }
  );
  res.status(201).json(session);
};
