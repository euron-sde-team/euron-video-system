import { sql } from "kysely";
import { ulid } from "ulid";
import { getDb, type Row } from "../db/index.js";
import { emitEvent } from "./events.js";
import { JOB_REAP_SQL, REAP_SQL } from "./sql.js";

export * from "./sql.js";
export * from "./events.js";

export type VideoRow = Row<"videos">;
export type JobRow = Row<"jobs">;

/**
 * Postgres as the work queue. No SQS, no Redis.
 *
 * Claims use `FOR UPDATE SKIP LOCKED`, so N workers polling concurrently each
 * get a distinct row with no thundering herd. Every subsequent mutation is
 * guarded by `(locked_by = me AND status = 'processing')`: a worker that lost
 * its claim (to the reaper, to a cancel, to a Spot reclaim and requeue) can
 * never clobber a row another worker now owns. Every guarded write reports
 * whether it landed so the caller logs the truth.
 *
 * See docs/architecture/LLD.md#queue-state-machine and ADR-0001.
 */

const affected = (r: { numAffectedRows?: bigint }): boolean => Number(r.numAffectedRows ?? 0n) > 0;

// ─── Primary queue: videos ───────────────────────────────────────────────────

/** CLAIM one 'uploaded' video, oldest first. Null when the queue is empty. */
export const claimNext = async (workerId: string): Promise<VideoRow | null> => {
  const result = await sql<VideoRow>`
    UPDATE videos SET
      status = 'processing', stage = 'transcoding', progress = 0,
      locked_by = ${workerId}, locked_at = now(), heartbeat_at = now(),
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM videos
      WHERE status = 'uploaded'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `.execute(getDb());
  return result.rows[0] ?? null;
};

/** HEARTBEAT every ~30s with stage + progress. False = claim lost: abort now. */
export const heartbeat = async (
  id: string,
  workerId: string,
  stage: string,
  progress: number
): Promise<boolean> =>
  affected(
    await sql`
      UPDATE videos SET heartbeat_at = now(), stage = ${stage}::video_stage, progress = ${progress}
      WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
    `.execute(getDb())
  );

/** Record orientation (from ffprobe) on the claimed row. */
export const setOrientation = async (id: string, workerId: string, orientation: string): Promise<void> => {
  await sql`
    UPDATE videos SET orientation = ${orientation}::orientation, updated_at = now()
    WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
  `.execute(getDb());
};

/** RELEASE on Spot interruption: hand back WITHOUT penalty (undo the attempt++). */
export const releaseClaim = async (id: string, workerId: string): Promise<void> => {
  await sql`
    UPDATE videos SET
      status = 'uploaded', stage = NULL,
      locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
      attempts = attempts - 1, updated_at = now()
    WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
  `.execute(getDb());
};

export interface RenditionRecord {
  label: string;
  width: number;
  height: number;
  bitrateKbps: number;
  codec: string;
}

/**
 * MARK READY + ENQUEUE follow-up jobs + EMIT video.ready, atomically.
 *
 * The video becomes playable the moment its HLS tree is uploaded; captions and
 * the downloadable MP4 are produced afterwards by independent, resumable jobs.
 * One transaction guarantees we never flip 'ready' without queueing the
 * follow-up work, never queue work for a row we lost to the reaper, and never
 * notify webhooks about a transition that did not commit.
 *
 * Returns false when the guarded flip did not land (claim lost).
 */
export const markReadyAndEnqueue = async (
  id: string,
  workerId: string,
  result: {
    outputBytes: number;
    durationSeconds: number;
    renditions: RenditionRecord[];
    enqueueCaptions: boolean;
    enqueueDownload: boolean;
  }
): Promise<boolean> =>
  getDb()
    .transaction()
    .execute(async (trx) => {
      const flipped = await sql<{ title: string; external_ref: string | null }>`
        UPDATE videos SET
          status = 'ready', stage = NULL, progress = 100,
          output_bytes = ${result.outputBytes}, duration_seconds = ${Math.round(result.durationSeconds)},
          captions_status = ${result.enqueueCaptions ? "pending" : "skipped"}::video_artifact_status,
          mp4_status = ${result.enqueueDownload ? "pending" : "skipped"}::video_artifact_status,
          error = NULL, ready_at = now(), updated_at = now()
        WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
        RETURNING title, external_ref
      `.execute(trx);
      const video = flipped.rows[0];
      if (!video) return false;

      for (const r of result.renditions) {
        await sql`
          INSERT INTO video_renditions (id, video_id, label, width, height, bitrate_kbps, codec)
          VALUES (${ulid()}, ${id}, ${r.label}, ${r.width}, ${r.height}, ${r.bitrateKbps}, ${r.codec})
          ON CONFLICT (video_id, label) DO UPDATE
            SET width = EXCLUDED.width, height = EXCLUDED.height,
                bitrate_kbps = EXCLUDED.bitrate_kbps, codec = EXCLUDED.codec
        `.execute(trx);
      }

      const kinds: Array<"CAPTIONS" | "DOWNLOAD"> = [];
      if (result.enqueueCaptions) kinds.push("CAPTIONS");
      if (result.enqueueDownload) kinds.push("DOWNLOAD");
      for (const kind of kinds) {
        await sql`
          INSERT INTO jobs (id, video_id, kind, status) VALUES (${ulid()}, ${id}, ${kind}::job_kind, 'queued')
        `.execute(trx);
      }

      await sql`
        INSERT INTO usage_daily (day, transcode_seconds) VALUES (current_date, ${Math.round(result.durationSeconds)})
        ON CONFLICT (day) DO UPDATE
          SET transcode_seconds = usage_daily.transcode_seconds + EXCLUDED.transcode_seconds, updated_at = now()
      `.execute(trx);

      await emitEvent(trx, "video.ready", {
        videoId: id,
        title: video.title,
        externalRef: video.external_ref,
        durationSeconds: Math.round(result.durationSeconds),
        renditions: result.renditions.map((r) => r.label),
      });
      return true;
    });

/**
 * FAIL or REQUEUE after an error. Past max_attempts the video goes terminal
 * 'failed' and video.failed is emitted; otherwise it returns to 'uploaded' for
 * another worker to retry.
 */
export const failOrRequeue = async (id: string, workerId: string, errorMessage: string): Promise<void> => {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      const res = await sql<{ status: string; external_ref: string | null }>`
        UPDATE videos SET
          status = (CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'uploaded' END)::video_status,
          -- A terminally failed video will never produce captions or an MP4:
          -- resolve them now so no client shows "preparing" forever.
          captions_status = (CASE WHEN attempts >= max_attempts AND captions_status = 'pending'
                                  THEN 'skipped' ELSE captions_status::text END)::video_artifact_status,
          mp4_status = (CASE WHEN attempts >= max_attempts AND mp4_status = 'pending'
                             THEN 'skipped' ELSE mp4_status::text END)::video_artifact_status,
          stage = NULL, locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
          error = ${errorMessage}, updated_at = now()
        WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
        RETURNING status, external_ref
      `.execute(trx);
      const row = res.rows[0];
      if (row?.status === "failed") {
        await emitEvent(trx, "video.failed", { videoId: id, externalRef: row.external_ref, error: errorMessage });
      }
    });
};

/** Reaper (worker/API path). The Lambda runs REAP_SQL with its own client. */
export const reapStale = async (): Promise<number> => {
  const result = await sql.raw(REAP_SQL).execute(getDb());
  return Number(result.numAffectedRows ?? 0n);
};

// ─── Background queue: jobs (CAPTIONS + DOWNLOAD) ────────────────────────────

/**
 * CLAIM one queued job. Jobs whose parent video was cancelled are never
 * claimed: their artifacts would be garbage and could recreate objects the
 * cancelled-artifact sweep already reclaimed.
 */
export const claimNextJob = async (workerId: string): Promise<JobRow | null> => {
  const result = await sql<JobRow>`
    UPDATE jobs SET
      status = 'processing', locked_by = ${workerId}, locked_at = now(), heartbeat_at = now(),
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT j.id FROM jobs j
      WHERE j.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.id = j.video_id AND v.status = 'cancelled')
      ORDER BY j.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `.execute(getDb());
  return result.rows[0] ?? null;
};

/**
 * HEARTBEAT a job. Also returns false when the parent video was cancelled
 * mid-job: the worker wires that to its AbortController, so a running job for
 * a freshly cancelled video is killed instead of re-uploading artifacts into a
 * swept prefix.
 */
export const jobHeartbeat = async (id: string, workerId: string): Promise<boolean> =>
  affected(
    await sql`
      UPDATE jobs SET heartbeat_at = now(), updated_at = now()
      WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.id = jobs.video_id AND v.status = 'cancelled')
    `.execute(getDb())
  );

/** RELEASE a job on Spot interruption, without penalty. */
export const releaseJobClaim = async (id: string, workerId: string): Promise<void> => {
  await sql`
    UPDATE jobs SET
      status = 'queued', locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
      attempts = attempts - 1, updated_at = now()
    WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
  `.execute(getDb());
};

/** DONE. False = the claim was lost before the write. */
export const markJobDone = async (id: string, workerId: string): Promise<boolean> =>
  affected(
    await sql`
      UPDATE jobs SET
        status = 'done', locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
        error = NULL, updated_at = now()
      WHERE id = ${id} AND locked_by = ${workerId} AND status = 'processing'
    `.execute(getDb())
  );

/** FAIL or REQUEUE a job. Terminal failure also flips the matching videos.*_status. */
export const failOrRequeueJob = async (job: JobRow, workerId: string, errorMessage: string): Promise<void> => {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      const res = await sql<{ status: string }>`
        UPDATE jobs SET
          status = (CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END)::job_status,
          locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
          error = ${errorMessage}, updated_at = now()
        WHERE id = ${job.id} AND locked_by = ${workerId} AND status = 'processing'
        RETURNING status
      `.execute(trx);
      if (res.rows[0]?.status !== "failed") return;
      const column = job.kind === "CAPTIONS" ? sql.ref("captions_status") : sql.ref("mp4_status");
      await sql`
        UPDATE videos SET ${column} = 'failed'::video_artifact_status, updated_at = now() WHERE id = ${job.video_id}
      `.execute(trx);
    });
};

/** Mark an artifact as actively processing (a UI nicety while its job runs). */
export const setArtifactProcessing = async (videoId: string, kind: "CAPTIONS" | "DOWNLOAD"): Promise<void> => {
  const column = kind === "CAPTIONS" ? sql.ref("captions_status") : sql.ref("mp4_status");
  await sql`
    UPDATE videos SET ${column} = 'processing'::video_artifact_status, updated_at = now()
    WHERE id = ${videoId} AND ${column} = 'pending'
  `.execute(getDb());
};

/** CAPTIONS success: record the produced language(s), flip status, emit captions.ready. */
export const markCaptionsReady = async (videoId: string, langs: string[]): Promise<void> => {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      await sql`
        UPDATE videos SET
          captions_langs = ${sql.val(langs)}, captions_status = 'ready'::video_artifact_status, updated_at = now()
        WHERE id = ${videoId}
      `.execute(trx);
      await emitEvent(trx, "captions.ready", { videoId, languages: langs });
    });
};

/** CAPTIONS no-op: the source had no audio to transcribe. */
export const markCaptionsSkipped = async (videoId: string): Promise<void> => {
  await sql`
    UPDATE videos SET captions_status = 'skipped'::video_artifact_status, updated_at = now() WHERE id = ${videoId}
  `.execute(getDb());
};

/** DOWNLOAD success: flip the MP4 status and emit download.ready. */
export const markMp4Ready = async (videoId: string): Promise<void> => {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      await sql`
        UPDATE videos SET mp4_status = 'ready'::video_artifact_status, updated_at = now() WHERE id = ${videoId}
      `.execute(trx);
      await emitEvent(trx, "download.ready", { videoId });
    });
};

/** Reaper for the job queue (worker/API path). */
export const reapStaleJobs = async (): Promise<number> => {
  const result = await sql.raw(JOB_REAP_SQL).execute(getDb());
  return Number(result.numAffectedRows ?? 0n);
};

// ─── Cancelled-artifact sweep ────────────────────────────────────────────────

export interface CancelledSweepRow {
  id: string;
  output_prefix: string | null;
  updated_at: Date;
}

/**
 * One keyset page of cancelled videos inside the artifact-sweep window: recent
 * enough that output objects may exist (or still land from a straggling
 * upload), old enough (15 min) that an in-flight abort has settled. Bounded to
 * 7 days so the sweep never scans deep history. Keyset pagination on
 * (updated_at, id) lets the caller drain a burst larger than one page; a bare
 * LIMIT with no cursor would starve the tail and leak its artifacts forever.
 */
export const listCancelledPage = async (
  after: { updatedAt: Date; id: string },
  limit = 200
): Promise<CancelledSweepRow[]> => {
  const result = await sql<CancelledSweepRow>`
    SELECT id, output_prefix, updated_at FROM videos
    WHERE status = 'cancelled'
      AND updated_at BETWEEN now() - interval '7 days' AND now() - interval '15 minutes'
      AND (updated_at, id) > (${after.updatedAt}, ${after.id})
    ORDER BY updated_at ASC, id ASC
    LIMIT ${limit}
  `.execute(getDb());
  return result.rows;
};
