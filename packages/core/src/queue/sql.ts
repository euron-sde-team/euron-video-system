// Raw queue SQL as plain strings with NO imports, so the Lambda orchestrator can
// run REAP/COUNT with its own per-invocation pg client without pulling in the
// shared pool (Lambda connection hygiene: a module-scope pool in a frozen
// execution environment leaks connections across invocations).

/** Reclaim dead or stuck 'processing' videos; give up past max_attempts. */
export const REAP_SQL = `
  UPDATE videos
  SET status = (CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'uploaded' END)::video_status,
      captions_status = (CASE WHEN attempts >= max_attempts AND captions_status = 'pending'
                              THEN 'skipped' ELSE captions_status::text END)::video_artifact_status,
      mp4_status = (CASE WHEN attempts >= max_attempts AND mp4_status = 'pending'
                         THEN 'skipped' ELSE mp4_status::text END)::video_artifact_status,
      stage = NULL, locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
      error = CASE WHEN attempts >= max_attempts THEN 'max attempts exceeded' ELSE error END,
      updated_at = now()
  WHERE status = 'processing'
    AND (heartbeat_at < now() - interval '10 minutes' OR locked_at < now() - interval '6 hours')
`;

/**
 * The two buckets the scale-up controller needs, in ONE round trip:
 *   queued      = 'uploaded'   unclaimed, still needs a worker
 *   in_progress = 'processing' already claimed (each has or had a worker)
 *
 * The controller launches for `queued` ONLY, offset by spare workers
 * (running - in_progress). Counting 'processing' into the launch numerator
 * double-counts against `running` and over-launches whenever a busy worker is
 * momentarily uncounted (still booting, tag not yet visible to
 * DescribeInstances, or Spot-reclaimed before its claim is reaped).
 */
export const COUNT_QUEUE_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'uploaded')::int   AS queued,
    count(*) FILTER (WHERE status = 'processing')::int AS in_progress
  FROM videos
  WHERE status IN ('uploaded', 'processing')
`;

// ─── Background job queue (CAPTIONS + DOWNLOAD) ──────────────────────────────

/** Reclaim stuck jobs, independently per row: requeuing the MP4 job never touches a finished captions job. */
export const JOB_REAP_SQL = `
  UPDATE jobs
  SET status = (CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END)::job_status,
      locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
      error = CASE WHEN attempts >= max_attempts THEN 'max attempts exceeded' ELSE error END,
      updated_at = now()
  WHERE status = 'processing'
    AND (heartbeat_at < now() - interval '10 minutes' OR locked_at < now() - interval '6 hours')
`;

export const JOB_COUNT_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'queued')::int     AS queued,
    count(*) FILTER (WHERE status = 'processing')::int AS in_progress
  FROM jobs
  WHERE status IN ('queued', 'processing')
`;

/**
 * Reconcile the denormalized videos.*_status columns when the REAPER (not the
 * worker) terminally fails a job. Worker-path failures already flip the column
 * in failOrRequeueJob; a reaper hard-fail must not leave a UI stuck on
 * "preparing". Idempotent; two static statements in one simple-protocol query.
 */
export const JOB_RECONCILE_SQL = `
  UPDATE videos v SET captions_status = 'failed'::video_artifact_status, updated_at = now()
    FROM jobs j
    WHERE j.video_id = v.id AND j.kind = 'CAPTIONS' AND j.status = 'failed'
      AND v.captions_status IN ('pending', 'processing');
  UPDATE videos v SET mp4_status = 'failed'::video_artifact_status, updated_at = now()
    FROM jobs j
    WHERE j.video_id = v.id AND j.kind = 'DOWNLOAD' AND j.status = 'failed'
      AND v.mp4_status IN ('pending', 'processing');
`;

/**
 * Retire queued jobs whose parent video was cancelled. claimNextJob already
 * refuses them; this flips them to a terminal 'cancelled' so JOB_COUNT_SQL's
 * backlog stays honest and the controller never launches workers for
 * unclaimable work. Running jobs are not touched: their heartbeat guard aborts
 * them worker-side, after which this catches the requeued row.
 */
export const JOB_CANCEL_SQL = `
  UPDATE jobs j
  SET status = 'cancelled'::job_status,
      locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
      error = 'parent video cancelled', updated_at = now()
  WHERE j.status = 'queued'
    AND EXISTS (SELECT 1 FROM videos v WHERE v.id = j.video_id AND v.status = 'cancelled')
`;
