import "./env.js"; // must stay the first import: sets TZ=UTC before anything loads
import { getCoreConfig, getWorkerConfig } from "@evs/core/config";
import { objectKeys } from "@evs/core/constants";
import { closeDatabase, waitForDatabase } from "@evs/core/db";
import logger from "@evs/core/logger";
import {
  claimNext,
  claimNextJob,
  failOrRequeue,
  failOrRequeueJob,
  jobHeartbeat,
  listCancelledPage,
  markJobDone,
  markReadyAndEnqueue,
  releaseClaim,
  releaseJobClaim,
  type JobRow,
  type VideoRow,
} from "@evs/core/queue";
import { storage } from "@evs/core/storage";
import { Heartbeat } from "./heartbeat.js";
import { runCaptionsJob } from "./jobs/captions.js";
import { runDownloadJob } from "./jobs/download.js";
import { runPrimary } from "./pipeline.js";
import { toPublicError } from "./public-error.js";
import { getPlatform } from "./platform.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let WORKER_ID = "";
// What this worker currently holds, so the Spot/SIGTERM path hands back the
// RIGHT claim: a PRIMARY video (releaseClaim) or a background job (releaseJobClaim).
let currentClaim: { type: "video" | "job"; id: string } | null = null;
let shuttingDown = false;

/**
 * Reclaim the artifacts of recently cancelled videos: the media tree (HLS
 * segments, playlists, thumbnails, captions) plus the private processed MP4.
 * Runs at startup (fire-and-forget) and before idle self-termination (awaited),
 * so the worker that just aborted a cancelled mid-transcode video sweeps its own
 * partial upload on the way out. Idempotent per video. Raw sources in the
 * uploads bucket are expired by its lifecycle rule.
 */
async function sweepCancelledArtifacts(): Promise<void> {
  try {
    const PAGE = 200;
    // Keyset-drain the WHOLE 7-day window (no starvation on cancel bursts).
    let cursor = { updatedAt: new Date(0), id: "" };
    for (;;) {
      const rows = await listCancelledPage(cursor, PAGE);
      if (rows.length === 0) return;
      for (const row of rows) {
        if (shuttingDown) return;
        try {
          const deleted = await storage.deletePrefix("media", row.output_prefix ?? objectKeys.outputPrefix(row.id));
          await storage.deleteObject("downloads", objectKeys.download(row.id));
          if (deleted > 0) logger.info(`[worker] swept ${deleted} object(s) of cancelled video ${row.id}`);
        } catch (e) {
          // Best-effort: a failed delete is retried on the next sweep in-window.
          logger.warn(`[worker] artifact sweep failed for cancelled video ${row.id}: ${e}`);
        }
      }
      const last = rows[rows.length - 1] as (typeof rows)[number];
      cursor = { updatedAt: last.updated_at, id: last.id };
      if (rows.length < PAGE) return;
    }
  } catch (e) {
    logger.warn(`[worker] artifact sweep query failed: ${e}`);
  }
}

/** Spot-interruption / SIGTERM path: hand the current claim back WITHOUT a penalty, then exit fast. */
const releaseAndExit = async (reason: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`[worker] ${reason}: releasing current claim`);
  if (currentClaim && WORKER_ID) {
    try {
      if (currentClaim.type === "video") await releaseClaim(currentClaim.id, WORKER_ID);
      else await releaseJobClaim(currentClaim.id, WORKER_ID);
    } catch (e) {
      logger.error(`[worker] release failed: ${e}`);
    }
  }
  await closeDatabase();
  process.exit(0);
};

/** PRIMARY transcode, then flip READY + enqueue the background jobs atomically. */
async function runVideo(video: VideoRow): Promise<void> {
  currentClaim = { type: "video", id: video.id };
  // Cooperative cancellation: when the heartbeat's guarded UPDATE hits 0 rows
  // (claim stolen by the reaper, or the video cancelled), it fires onLost ->
  // abort, so runPrimary SIGKILLs any in-flight ffmpeg and bails instead of
  // finishing a transcode for a video this worker no longer owns.
  const ac = new AbortController();
  const hb = new Heartbeat(video.id, WORKER_ID, () => ac.abort());
  hb.start();
  try {
    logger.info(`[worker] claimed video ${video.id} (attempt ${video.attempts}/${video.max_attempts})`);
    const outcome = await runPrimary(video, WORKER_ID, hb, ac.signal);
    hb.stop();
    const flipped = await markReadyAndEnqueue(video.id, WORKER_ID, {
      outputBytes: outcome.outputBytes,
      durationSeconds: outcome.durationSec,
      renditions: outcome.renditions,
      enqueueCaptions: outcome.enqueueCaptions,
      enqueueDownload: outcome.enqueueDownload,
    });
    if (flipped) {
      logger.info(
        `[worker] ready ${video.id} (captions=${outcome.enqueueCaptions ? "queued" : "skipped"}, ` +
          `download=${outcome.enqueueDownload ? "queued" : "skipped"})`
      );
    } else {
      // Claim lost at the finish line: the guarded write no-oped and another
      // actor's state wins. Log the truth, never "ready".
      logger.warn(`[worker] ready write no-oped for ${video.id} (claim lost at finish)`);
    }
  } catch (err) {
    hb.stop();
    const msg = (err as Error).message ?? String(err);
    // Full detail to the log; a scrubbed, client-safe message to the row.
    logger.error(`[worker] video ${video.id} failed: ${msg}`);
    await failOrRequeue(video.id, WORKER_ID, toPublicError(err)).catch((e) =>
      logger.error(`[worker] failOrRequeue failed: ${e}`)
    );
  } finally {
    currentClaim = null;
  }
}

/** Background artifact job: independently claimed + heartbeated, so a Spot reclaim requeues ONLY this job. */
async function runBackgroundJob(job: JobRow): Promise<void> {
  currentClaim = { type: "job", id: job.id };
  // A 0-row heartbeat (claim stolen, or parent video cancelled) aborts the job.
  // A transient DB error is caught and does NOT abort (it would otherwise kill a
  // healthy encode on a blip); only a definitive not-owned result does.
  const ac = new AbortController();
  const timer = setInterval(() => {
    void jobHeartbeat(job.id, WORKER_ID)
      .then((owned) => {
        if (!owned) ac.abort();
      })
      .catch((e) => logger.warn(`[job-hb ${job.id}] ${e}`));
  }, getWorkerConfig().HEARTBEAT_MS);
  try {
    logger.info(
      `[worker] claimed ${job.kind} job ${job.id} for video ${job.video_id} (attempt ${job.attempts}/${job.max_attempts})`
    );
    if (job.kind === "CAPTIONS") await runCaptionsJob(job, ac.signal);
    else await runDownloadJob(job, ac.signal);
    clearInterval(timer);
    const done = await markJobDone(job.id, WORKER_ID);
    if (done) logger.info(`[worker] ${job.kind} job ${job.id} done`);
    else logger.warn(`[worker] ${job.kind} job ${job.id} done-write no-oped (claim lost at finish)`);
  } catch (err) {
    clearInterval(timer);
    const msg = (err as Error).message ?? String(err);
    logger.error(`[worker] ${job.kind} job ${job.id} failed: ${msg}`);
    await failOrRequeueJob(job, WORKER_ID, toPublicError(err)).catch((e) =>
      logger.error(`[worker] failOrRequeueJob failed: ${e}`)
    );
  } finally {
    currentClaim = null;
  }
}

async function main(): Promise<void> {
  // Validate configuration up front: a misconfigured worker fails at boot, not mid-job.
  getCoreConfig();
  const cfg = getWorkerConfig();
  const platform = getPlatform();

  WORKER_ID = await platform.workerId();
  logger.info(`[worker] id=${WORKER_ID} platform=${platform.kind} mode=${cfg.WORKER_MODE}`);
  await waitForDatabase();

  // Startup sweep, fire-and-forget so it never delays the first claim; the
  // awaited pre-shutdown sweep below is the reliable pass.
  void sweepCancelledArtifacts();

  const watcher =
    platform.kind === "ec2"
      ? setInterval(() => {
          void platform
            .interruptionPending()
            .then((notice) => {
              if (notice) void releaseAndExit("Spot interruption notice");
            })
            .catch(() => {});
        }, 5000)
      : null;

  let idleSince: number | null = null;

  // Pool role: "primary" claims videos only, "jobs" claims background jobs only,
  // "all" claims both. A small jobs-pool instance therefore never picks up a
  // heavy primary transcode, and big primary instances aren't spent on whisper.
  const claimsVideos = cfg.WORKER_MODE !== "jobs";
  const claimsJobs = cfg.WORKER_MODE !== "primary";

  while (!shuttingDown) {
    // PRIMARY (the playback path) has strict priority: a background job is only
    // claimed when no video is waiting, so time-to-watchable is never delayed by
    // captions or MP4 work.
    if (claimsVideos) {
      const video = await claimNext(WORKER_ID).catch((e) => {
        logger.error(`[worker] claim failed: ${e}`);
        return null;
      });
      if (video) {
        idleSince = null;
        await runVideo(video);
        continue;
      }
    }

    if (claimsJobs) {
      const job = await claimNextJob(WORKER_ID).catch((e) => {
        logger.error(`[worker] job claim failed: ${e}`);
        return null;
      });
      if (job) {
        idleSince = null;
        await runBackgroundJob(job);
        continue;
      }
    }

    idleSince ??= Date.now();
    if (platform.kind === "ec2" && Date.now() - idleSince > cfg.IDLE_GRACE_MS) {
      logger.info(`[worker] idle ${cfg.IDLE_GRACE_MS}ms with an empty queue, shutting down`);
      if (watcher) clearInterval(watcher);
      // Final artifact sweep before the instance goes away, deadline-capped so a
      // hung socket can never block self-termination.
      await Promise.race([sweepCancelledArtifacts(), sleep(5 * 60_000)]);
      await closeDatabase();
      platform.shutdownWhenIdle();
      process.exit(0);
    }
    await sleep(cfg.POLL_MS);
  }
}

process.on("SIGTERM", () => void releaseAndExit("SIGTERM"));
process.on("SIGINT", () => void releaseAndExit("SIGINT"));
process.on("unhandledRejection", (r) => logger.error(`[worker] unhandledRejection: ${r}`));

main().catch(async (e) => {
  logger.error(`[worker] fatal: ${e instanceof Error ? e.message : e}`);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
