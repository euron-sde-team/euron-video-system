import { ulid } from "ulid";
import { getApiConfig } from "@evs/core/config";
import { ALLOWED_UPLOAD_EXT, OUTPUT_FILES, objectKeys } from "@evs/core/constants";
import { getDb, toNullableNumber, type VideoStatus } from "@evs/core/db";
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError, UnprocessableError } from "@evs/core/errors";
import logger from "@evs/core/logger";
import { emitEvent } from "@evs/core/queue";
import { storage } from "@evs/core/storage";
import { getDeliveryDriver } from "../delivery/index.js";
import { iso } from "../http/pagination.js";
import policiesRepository from "../repositories/policies.repository.js";
import usageRepository from "../repositories/usage.repository.js";
import videosRepository, { type RenditionRow, type VideoRow } from "../repositories/videos.repository.js";

/** Poster URLs in management responses are signed for this long. */
const POSTER_TTL_SECONDS = 600;
const DOWNLOAD_TTL_SECONDS = 300;

export interface VideoResponse {
  id: string;
  title: string;
  externalRef: string | null;
  metadata: unknown;
  status: string;
  stage: string | null;
  progress: number;
  orientation: string | null;
  durationSeconds: number | null;
  protection: string;
  watermark: string;
  playbackPolicyId: string | null;
  captions: { status: string; languages: string[] };
  download: { status: string };
  sourceBytes: number | null;
  outputBytes: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  updatedAt: string | null;
  readyAt: string | null;
  posterUrl: string | null;
  renditions?: Array<{ label: string; width: number; height: number; bitrateKbps: number; codec: string }>;
}

const toVideoResponse = (row: VideoRow, posterUrl: string | null, renditions?: RenditionRow[]): VideoResponse => ({
  id: row.id,
  title: row.title,
  externalRef: row.external_ref,
  metadata: row.metadata,
  status: row.status,
  stage: row.stage,
  progress: row.progress,
  orientation: row.orientation,
  durationSeconds: row.duration_seconds,
  protection: row.protection,
  watermark: row.watermark,
  playbackPolicyId: row.playback_policy_id,
  captions: { status: row.captions_status, languages: row.captions_langs },
  download: { status: row.mp4_status },
  sourceBytes: toNullableNumber(row.source_bytes),
  outputBytes: toNullableNumber(row.output_bytes),
  error: row.error,
  attempts: row.attempts,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  readyAt: iso(row.ready_at),
  posterUrl,
  ...(renditions
    ? {
        renditions: renditions.map((r) => ({
          label: r.label,
          width: r.width,
          height: r.height,
          bitrateKbps: r.bitrate_kbps,
          codec: r.codec,
        })),
      }
    : {}),
});

/** Bounded-concurrency map preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

class VideosService {
  /**
   * Signed poster URL for console/listing use. Never fails the response: a
   * storage hiccup just yields a null poster.
   */
  private async posterFor(row: VideoRow): Promise<string | null> {
    if (row.status !== "ready") return null;
    try {
      const driver = getDeliveryDriver();
      // The proxy driver needs a playback token; management listings use a
      // presigned URL instead so the console needs no viewer session.
      if (driver.name === "proxy") {
        return await storage.presignGet("media", `${objectKeys.outputPrefix(row.id)}/${OUTPUT_FILES.poster}`, POSTER_TTL_SECONDS);
      }
      const [url] = await driver.urlsFor(row.id, [OUTPUT_FILES.poster], POSTER_TTL_SECONDS, "");
      return url ?? null;
    } catch (err) {
      logger.warn("poster signing failed", { videoId: row.id, err: (err as Error).message });
      return null;
    }
  }

  /** POST /v1/videos: validate, apply backpressure, create the row, presign the upload. */
  async create(input: {
    title: string;
    filename: string;
    externalRef?: string | null;
    metadata?: Record<string, unknown>;
    playbackPolicyId?: string | null;
    captions?: boolean;
  }): Promise<{ video: VideoResponse; upload: { url: string; fields: Record<string, string>; expiresAt: string } }> {
    const cfg = getApiConfig();
    const ext = input.filename.split(".").pop()?.toLowerCase();
    if (!ext || !ALLOWED_UPLOAD_EXT.has(ext)) {
      throw new UnprocessableError(`Unsupported file type. Allowed: ${[...ALLOWED_UPLOAD_EXT].join(", ")}`);
    }
    if (input.playbackPolicyId && !(await policiesRepository.findById(input.playbackPolicyId))) {
      throw new BadRequestError("playbackPolicyId does not exist");
    }
    if ((await videosRepository.countInFlight()) >= cfg.MAX_IN_FLIGHT) {
      throw new TooManyRequestsError("Too many videos in flight; retry once some finish processing");
    }

    // The id is generated up front so the storage keys embed it.
    const id = ulid();
    const sourceKey = objectKeys.source(id, ext);
    const row = await getDb()
      .transaction()
      .execute(async (trx) => {
        const created = await videosRepository.create(
          {
            id,
            title: input.title,
            externalRef: input.externalRef ?? null,
            metadata: input.metadata ?? {},
            playbackPolicyId: input.playbackPolicyId ?? null,
            sourceKey,
            outputPrefix: objectKeys.outputPrefix(id),
            pipelineConfig: { captions: input.captions ?? true },
          },
          trx
        );
        await emitEvent(trx, "video.created", { videoId: id, title: input.title, externalRef: input.externalRef ?? null });
        return created;
      });

    const expiresSeconds = 3600;
    const upload = await storage.presignUpload(sourceKey, cfg.MAX_UPLOAD_BYTES, expiresSeconds);
    return {
      video: toVideoResponse(row, null),
      upload: {
        url: upload.url,
        fields: upload.fields,
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
      },
    };
  }

  /** POST /v1/videos/:id/complete: HeadObject-verify, then enqueue (uploading -> uploaded). */
  async complete(id: string): Promise<VideoResponse> {
    const video = await videosRepository.findById(id);
    if (!video) throw new NotFoundError("Video not found");
    if (video.status !== "uploading") throw new ConflictError(`Cannot complete a video in status ${video.status}`);
    if (!video.source_key) throw new BadRequestError("Video has no source key");

    const size = await storage.headSize("uploads", video.source_key);
    if (size === null) throw new UnprocessableError("Upload not found in storage; upload the file before completing");

    await getDb()
      .transaction()
      .execute(async (trx) => {
        const ok = await videosRepository.markUploaded(id, size, trx);
        if (!ok) throw new ConflictError("Video was modified concurrently");
        await usageRepository.increment("videos_created", 1, trx);
        await emitEvent(trx, "video.uploaded", { videoId: id, sourceBytes: size });
      });
    return this.get(id);
  }

  async get(id: string): Promise<VideoResponse> {
    const row = await videosRepository.findById(id);
    if (!row) throw new NotFoundError("Video not found");
    const [poster, renditions] = await Promise.all([this.posterFor(row), videosRepository.renditions(id)]);
    return toVideoResponse(row, poster, renditions);
  }

  async list(params: { status?: VideoStatus; q?: string; page: number; limit: number }): Promise<{
    rows: VideoResponse[];
    total: number;
  }> {
    const { rows, total } = await videosRepository.list(params);
    const videos = await mapPool(rows, 8, async (r) => toVideoResponse(r, await this.posterFor(r)));
    return { rows: videos, total };
  }

  async update(
    id: string,
    patch: { title?: string; metadata?: Record<string, unknown>; externalRef?: string | null; playbackPolicyId?: string | null }
  ): Promise<VideoResponse> {
    if (patch.playbackPolicyId && !(await policiesRepository.findById(patch.playbackPolicyId))) {
      throw new BadRequestError("playbackPolicyId does not exist");
    }
    if (!(await videosRepository.update(id, patch))) throw new NotFoundError("Video not found");
    return this.get(id);
  }

  async retry(id: string): Promise<VideoResponse> {
    const video = await videosRepository.findById(id);
    if (!video) throw new NotFoundError("Video not found");
    if (video.status !== "failed") throw new ConflictError(`Only failed videos can be retried (status: ${video.status})`);
    await videosRepository.retry(id);
    return this.get(id);
  }

  async cancel(id: string): Promise<VideoResponse> {
    const video = await videosRepository.findById(id);
    if (!video) throw new NotFoundError("Video not found");
    await getDb()
      .transaction()
      .execute(async (trx) => {
        if (!(await videosRepository.cancel(id, trx))) throw new ConflictError(`Cannot cancel a ${video.status} video`);
        await emitEvent(trx, "video.cancelled", { videoId: id, externalRef: video.external_ref });
      });
    return this.get(id);
  }

  /**
   * DELETE: soft-delete the row (kept for audit and webhook history), cancel
   * any in-flight processing, and remove every stored object. Storage cleanup
   * runs after the commit; a failure there is logged and the cancelled-artifact
   * sweep on the workers reclaims anything left behind.
   */
  async delete(id: string): Promise<void> {
    const video = await videosRepository.findById(id);
    if (!video) throw new NotFoundError("Video not found");
    await getDb()
      .transaction()
      .execute(async (trx) => {
        await videosRepository.cancel(id, trx); // no-op when already terminal
        await videosRepository.softDelete(id, trx);
        await emitEvent(trx, "video.deleted", { videoId: id, externalRef: video.external_ref });
      });

    const tasks: Array<Promise<unknown>> = [
      storage.deletePrefix("media", objectKeys.outputPrefix(id)),
      storage.deleteObject("downloads", objectKeys.download(id)),
    ];
    if (video.source_key) tasks.push(storage.deleteObject("uploads", video.source_key));
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "rejected") logger.warn("storage cleanup after delete failed", { videoId: id, err: String(r.reason) });
    }
  }

  /** Short-lived presigned URL for the processed MP4 in the private downloads bucket. */
  async downloadUrl(id: string): Promise<{ url: string; expiresAt: string; filename: string }> {
    const video = await videosRepository.findById(id);
    if (!video) throw new NotFoundError("Video not found");
    if (video.mp4_status !== "ready") throw new NotFoundError("Processed download is not available yet");
    const filename = `${video.title.replace(/[^\w.-]+/g, "_").slice(0, 120) || `video-${id.slice(0, 8)}`}.mp4`;
    const url = await storage.presignGet("downloads", objectKeys.download(id), DOWNLOAD_TTL_SECONDS, filename);
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(), filename };
  }

  async stats() {
    const s = await videosRepository.stats();
    return {
      videos: { total: s.total, byStatus: s.byStatus },
      storage: { sourceBytes: s.sourceBytes, outputBytes: s.outputBytes },
      queue: {
        queued: s.byStatus.uploaded ?? 0,
        processing: s.byStatus.processing ?? 0,
        jobsQueued: s.jobsQueued,
        jobsProcessing: s.jobsProcessing,
      },
      activeSessions: s.activeSessions,
    };
  }

  /** Delivery helper: the ready video, or 404. */
  async requireReady(id: string): Promise<VideoRow> {
    const video = await videosRepository.findById(id);
    if (!video || video.status !== "ready") throw new NotFoundError("Video not found or not ready");
    return video;
  }
}

export default new VideosService();
