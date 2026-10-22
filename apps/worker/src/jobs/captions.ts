import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { objectKeys } from "@evs/core/constants";
import logger from "@evs/core/logger";
import { markCaptionsReady, markCaptionsSkipped, setArtifactProcessing, type JobRow } from "@evs/core/queue";
import { generateCaptions } from "../encoding/captions.js";
import { OwnershipLostError } from "../encoding/exec.js";
import { buildMasterPlaylist, HLS_DIR, writeSubtitleRendition } from "../encoding/hls.js";
import { probe } from "../encoding/probe.js";
import { downloadSource, ladderFor, loadVideo, pipelineConfigOf } from "../pipeline.js";
import { uploadOutputTree } from "../upload.js";

/**
 * CAPTIONS background job. Re-downloads the source, runs whisper, then
 * re-uploads ONLY the small playlist files: the subtitle rendition
 * (subs/<lang>.*) and a rebuilt master.m3u8 that now exposes the CC track. The
 * rung segments are untouched. Because master.m3u8 carries a 5-minute
 * Cache-Control, a fresh playback session picks up captions with no
 * cache-busting. Throws on failure so the worker requeues just THIS job.
 */
export const runCaptionsJob = async (job: JobRow, signal: AbortSignal): Promise<void> => {
  const video = await loadVideo(job.video_id);
  if (!video) throw new Error(`captions job: video ${job.video_id} not found`);

  await setArtifactProcessing(job.video_id, "CAPTIONS");

  const jobDir = path.join(getWorkerConfig().WORK_DIR, `cap-${job.id}`);
  const sourceDir = path.join(jobDir, "src");
  // Upload root: only this subtree ships (master.m3u8 + subs/*), never src/.
  const hlsRoot = path.join(jobDir, HLS_DIR);
  await mkdir(sourceDir, { recursive: true });
  await mkdir(hlsRoot, { recursive: true });

  try {
    const inputPath = await downloadSource(video, sourceDir, signal);

    const probed = await probe(inputPath, signal);
    if (!probed.hasAudio) {
      logger.info(`[captions ${job.video_id}] source has no audio, marking skipped`);
      await markCaptionsSkipped(job.video_id);
      return;
    }

    const lang = pipelineConfigOf(video).captionsLang ?? getWorkerConfig().CAPTIONS_DEFAULT_LANG;
    const captions = await generateCaptions(inputPath, sourceDir, probed.hasAudio, lang, signal);
    // generateCaptions swallows errors into null, so an abort mid-whisper
    // surfaces here as null; distinguish it from a genuine whisper failure so the
    // right error is reported (never misreport a lost claim as "whisper failed").
    if (signal.aborted) throw new OwnershipLostError("captions");
    if (!captions) throw new Error("caption generation returned null (whisper failed or produced no vtt)");

    // Rebuild the master WITH the subtitle rendition using the SAME
    // deterministic ladder PRIMARY used (ladderFor applies the identical
    // near-static rule), then upload only master.m3u8 + subs/*.
    await writeSubtitleRendition(hlsRoot, captions.vttFile, captions.lang, probed.durationSec);
    const master = buildMasterPlaylist(
      ladderFor(probed).map((rung) => ({ rung })),
      probed.hasAudio,
      captions.lang
    );
    await writeFile(path.join(hlsRoot, "master.m3u8"), master);

    // Never publish a subtitle master or mark captions ready for a video this
    // worker no longer owns (markCaptionsReady is unguarded, so this is the gate).
    if (signal.aborted) throw new OwnershipLostError("captions");

    const prefix = video.output_prefix ?? objectKeys.outputPrefix(video.id);
    await uploadOutputTree(hlsRoot, `${prefix}/${HLS_DIR}`, signal);
    if (signal.aborted) throw new OwnershipLostError("captions");

    await markCaptionsReady(job.video_id, [captions.lang]);
    logger.info(`[captions ${job.video_id}] ready (${captions.lang})`);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
};
