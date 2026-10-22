import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { objectKeys } from "@evs/core/constants";
import logger from "@evs/core/logger";
import { markMp4Ready, setArtifactProcessing, type JobRow } from "@evs/core/queue";
import { encodeDownloadFromSource } from "../encoding/download.js";
import { OwnershipLostError } from "../encoding/exec.js";
import { probe } from "../encoding/probe.js";
import { downloadSource, ladderFor, loadVideo } from "../pipeline.js";
import { uploadPrivateFile } from "../upload.js";

/**
 * DOWNLOAD background job. Re-downloads the source and re-encodes a
 * size-conscious MP4 scaled to the top rung, then uploads it to the PRIVATE
 * downloads bucket. Encoding from source (not a local rung) is required: the
 * streaming rungs live in object storage as AES-128 TS, not on this worker.
 * Throws on failure so the worker requeues ONLY this job (an already-done
 * CAPTIONS job is untouched).
 */
export const runDownloadJob = async (job: JobRow, signal: AbortSignal): Promise<void> => {
  const video = await loadVideo(job.video_id);
  if (!video) throw new Error(`download job: video ${job.video_id} not found`);

  await setArtifactProcessing(job.video_id, "DOWNLOAD");

  const jobDir = path.join(getWorkerConfig().WORK_DIR, `dl-${job.id}`);
  const sourceDir = path.join(jobDir, "src");
  await mkdir(sourceDir, { recursive: true });

  try {
    const inputPath = await downloadSource(video, sourceDir, signal);
    const probed = await probe(inputPath, signal);
    // Scale to the top rung's dimensions (the same deterministic ladder PRIMARY used).
    const top = ladderFor(probed).reduce((best, cur) => (cur.width * cur.height > best.width * best.height ? cur : best));

    const processed = await encodeDownloadFromSource(
      inputPath,
      jobDir,
      top.scaleFilter,
      probed.hasAudio,
      probed.durationSec,
      signal
    );

    // If the claim was lost after the encode finished, bail before publishing
    // the MP4 or marking it ready (markMp4Ready is unguarded). The upload itself
    // is signal-aware, and the re-check after it closes the window between a
    // long upload and the status flip.
    if (signal.aborted) throw new OwnershipLostError("download");
    await uploadPrivateFile("downloads", objectKeys.download(video.id), processed, "video/mp4", signal);
    if (signal.aborted) throw new OwnershipLostError("download");

    await markMp4Ready(job.video_id);
    logger.info(`[download ${job.video_id}] ready`);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
};
