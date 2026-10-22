import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { HLS_KEY_URI_PLACEHOLDER, objectKeys } from "@evs/core/constants";
import { contentKeyStore } from "@evs/core/crypto/store";
import { getDb } from "@evs/core/db";
import logger from "@evs/core/logger";
import { setOrientation, type RenditionRecord, type VideoRow } from "@evs/core/queue";
import { storage } from "@evs/core/storage";
import { OwnershipLostError } from "./encoding/exec.js";
import { isNearStatic, transcode } from "./encoding/ffmpeg.js";
import { packageHlsAes, VIDEO_CODEC } from "./encoding/hls.js";
import { selectLadder, type Rung } from "./encoding/ladder.js";
import { probe, type ProbeResult } from "./encoding/probe.js";
import { generateThumbnails } from "./encoding/thumbnails.js";
import type { Heartbeat } from "./heartbeat.js";
import { uploadOutputTree } from "./upload.js";

export interface PrimaryOutcome {
  /** Total bytes of the packaged output tree uploaded to the media bucket. */
  outputBytes: number;
  /** Probed source duration in seconds (persisted by markReadyAndEnqueue). */
  durationSec: number;
  renditions: RenditionRecord[];
  /** Whether a CAPTIONS background job should be enqueued. */
  enqueueCaptions: boolean;
  /** Whether a DOWNLOAD background job should be enqueued. */
  enqueueDownload: boolean;
}

/** Per-video knobs stored in videos.pipeline_config. */
export interface PipelineConfig {
  captions?: boolean;
  /** Force a caption language (whisper `-l`); defaults to CAPTIONS_DEFAULT_LANG. */
  captionsLang?: string;
  download?: boolean;
}

export const pipelineConfigOf = (video: VideoRow): PipelineConfig =>
  (video.pipeline_config ?? {}) as PipelineConfig;

/**
 * The ladder for a probed source, identical for PRIMARY and the decoupled jobs.
 *
 * A near-static source reports a ~2 kbps VIDEO-stream bitrate (no motion), but
 * it is forced to CFR, which needs real bits for the per-4s keyframes; capping
 * to ~2 kbps starves x264 into flat gray. Passing bitrateKbps=0 for these makes
 * selectLadder's capToSource a no-op, so they get the full ladder bitrates.
 */
export const ladderFor = (probed: ProbeResult): Rung[] =>
  selectLadder(probed.orientation, probed.width, probed.height, isNearStatic(probed.fps) ? 0 : probed.bitrateKbps);

export const loadVideo = async (id: string): Promise<VideoRow | null> =>
  (await getDb().selectFrom("videos").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;

/** Stream the source from the uploads bucket into `dir`. Returns the local path. */
export const downloadSource = async (video: VideoRow, dir: string, signal: AbortSignal): Promise<string> => {
  if (!video.source_key) throw new Error(`video ${video.id} has no source_key`);
  const ext = video.source_key.split(".").pop() || "mp4";
  const inputPath = path.join(dir, `original.${ext}`);
  await storage.downloadToFile("uploads", video.source_key, inputPath, signal);
  return inputPath;
};

/**
 * PRIMARY transcode for one claimed video: the playback-critical path ONLY.
 * Decode + ABR ladder + thumbnails + AES-128 HLS packaging + upload, then the
 * caller flips the video to READY. Captions and the downloadable MP4 are
 * produced by decoupled jobs that run after READY, so the video is watchable the
 * moment this returns, not after whisper finishes. Everything happens in a
 * per-video temp dir that is always removed in `finally`.
 */
export const runPrimary = async (
  video: VideoRow,
  workerId: string,
  hb: Heartbeat,
  signal: AbortSignal
): Promise<PrimaryOutcome> => {
  const cfg = getWorkerConfig();
  const jobDir = path.join(cfg.WORK_DIR, video.id);
  const sourceDir = path.join(jobDir, "src");
  const renditionsDir = path.join(jobDir, "renditions");
  const outputDir = path.join(jobDir, "output");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(renditionsDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  try {
    const inputPath = await downloadSource(video, sourceDir, signal);

    // ── 1. probe + orientation -> ladder (capped to source bitrate) ──
    const probed = await probe(inputPath, signal);
    await setOrientation(video.id, workerId, probed.orientation);
    const ladder = ladderFor(probed);
    logger.info(
      `[pipeline ${video.id}] ${probed.width}x${probed.height} ${probed.orientation} ` +
        `rot=${probed.rotation}, ${ladder.length} rungs, ${probed.durationSec}s, ` +
        `audio=${probed.hasAudio}, src=${probed.bitrateKbps}kbps, fps=${probed.fps}`
    );

    // ── 2. transcoding (single decode, many encodes) + thumbnails ──
    // hb.update() double-checks ownership (guarded UPDATE); if the claim was
    // lost it fires onLost -> abort, so signal.aborted here means a genuine claim
    // loss. The boundary throws bail out of the GAPS between encoder runs (each
    // run() itself SIGKILLs its child on abort mid-encode).
    await hb.update("transcoding", 10);
    if (signal.aborted) throw new OwnershipLostError("primary");
    const { videoFiles, audioFile } = await transcode(
      inputPath,
      renditionsDir,
      ladder,
      probed.hasAudio,
      probed.rotation,
      probed.durationSec,
      probed.fps,
      signal
    );
    await hb.update("transcoding", 60);
    if (signal.aborted) throw new OwnershipLostError("primary");

    // Poster + sprites write straight into outputDir (shipped as-is).
    await generateThumbnails(inputPath, outputDir, probed.width, probed.height, probed.durationSec, signal);
    await hb.update("transcoding", 68);
    if (signal.aborted) throw new OwnershipLostError("primary");

    // ── 3. packaging: generate + wrap + store the content key, then AES-128 HLS ──
    // The master here has NO subtitle rendition; the CAPTIONS job re-uploads
    // master.m3u8 (with subs) once whisper finishes.
    await hb.update("packaging", 78);
    if (signal.aborted) throw new OwnershipLostError("primary");
    const key = await contentKeyStore.generateAndStore(video.id);
    await packageHlsAes({
      outputDir,
      videoFiles,
      audioFile,
      key: { keyBytes: key.keyBytes },
      keyUriPlaceholder: HLS_KEY_URI_PLACEHOLDER,
      workDir: renditionsDir,
      captions: null,
      durationSec: probed.durationSec,
      signal,
    });
    await hb.update("packaging", 88);
    if (signal.aborted) throw new OwnershipLostError("primary");

    // ── 4. uploading_output (the video is playable once this completes) ──
    // A claim lost here must NOT ship a full multi-GB tree for a video another
    // actor now owns, hence the boundary check and the signal-aware upload.
    await hb.update("uploading_output", 92);
    if (signal.aborted) throw new OwnershipLostError("primary");
    const prefix = video.output_prefix ?? objectKeys.outputPrefix(video.id);
    const { bytes: outputBytes } = await uploadOutputTree(outputDir, prefix, signal);

    const pc = pipelineConfigOf(video);
    return {
      outputBytes,
      durationSec: probed.durationSec,
      renditions: ladder.map((r) => ({
        label: r.name,
        width: r.width,
        height: r.height,
        bitrateKbps: r.maxrateKbps,
        codec: VIDEO_CODEC,
      })),
      enqueueCaptions: cfg.CAPTIONS_ENABLED && probed.hasAudio && pc.captions !== false,
      enqueueDownload: cfg.DOWNLOAD_ENABLED && pc.download !== false,
    };
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
};
