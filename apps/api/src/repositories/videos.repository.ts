import { sql } from "kysely";
import { getDb, toNumber, type Row, type Trx, type VideoStatus } from "@evs/core/db";

export type VideoRow = Row<"videos">;
export type RenditionRow = Row<"video_renditions">;

const NON_TERMINAL: VideoStatus[] = ["uploading", "uploaded", "processing"];

interface CreateInput {
  id: string;
  title: string;
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
  playbackPolicyId?: string | null;
  sourceKey: string;
  outputPrefix: string;
  pipelineConfig: Record<string, unknown>;
}

interface ListParams {
  status?: VideoStatus;
  q?: string;
  page: number;
  limit: number;
}

/**
 * Reads and writes for `videos` EXCEPT the queue-claim mechanics, which live
 * in @evs/core/queue (raw SQL with FOR UPDATE SKIP LOCKED). Soft-deleted rows
 * (deleted_at set) are invisible to every read here.
 */
class VideosRepository {
  async create(input: CreateInput, trx?: Trx): Promise<VideoRow> {
    return (trx || getDb())
      .insertInto("videos")
      .values({
        id: input.id,
        title: input.title,
        external_ref: input.externalRef ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        playback_policy_id: input.playbackPolicyId ?? null,
        status: "uploading",
        source_key: input.sourceKey,
        output_prefix: input.outputPrefix,
        pipeline_config: JSON.stringify(input.pipelineConfig),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string, trx?: Trx): Promise<VideoRow | null> {
    const row = await (trx || getDb())
      .selectFrom("videos")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row ?? null;
  }

  async list(params: ListParams): Promise<{ rows: VideoRow[]; total: number }> {
    const db = getDb();
    let base = db.selectFrom("videos").where("deleted_at", "is", null);
    if (params.status) base = base.where("status", "=", params.status);
    if (params.q) {
      const like = `%${params.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      base = base.where((eb) => eb.or([eb("title", "ilike", like), eb("external_ref", "ilike", like), eb("id", "=", params.q as string)]));
    }
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(params.limit)
        .offset((params.page - 1) * params.limit)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirst(),
    ]);
    return { rows, total: toNumber(count?.n) };
  }

  async update(
    id: string,
    patch: { title?: string; metadata?: Record<string, unknown>; externalRef?: string | null; playbackPolicyId?: string | null }
  ): Promise<boolean> {
    const res = await getDb()
      .updateTable("videos")
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.metadata !== undefined ? { metadata: JSON.stringify(patch.metadata) } : {}),
        ...(patch.externalRef !== undefined ? { external_ref: patch.externalRef } : {}),
        ...(patch.playbackPolicyId !== undefined ? { playback_policy_id: patch.playbackPolicyId } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /** In-flight = not yet terminal. Gates the MAX_IN_FLIGHT backpressure cap. */
  async countInFlight(): Promise<number> {
    const row = await getDb()
      .selectFrom("videos")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("status", "in", NON_TERMINAL)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return toNumber(row?.n);
  }

  /** ENQUEUE: uploading -> uploaded, recording the verified byte size. */
  async markUploaded(id: string, sourceBytes: number, trx?: Trx): Promise<boolean> {
    const res = await (trx || getDb())
      .updateTable("videos")
      .set({ status: "uploaded", source_bytes: String(sourceBytes), updated_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "uploading")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /** RETRY: failed -> uploaded with attempts reset, so a worker reprocesses it. */
  async retry(id: string): Promise<boolean> {
    const res = await getDb()
      .updateTable("videos")
      .set({
        status: "uploaded",
        attempts: 0,
        error: null,
        stage: null,
        progress: 0,
        locked_by: null,
        locked_at: null,
        heartbeat_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("status", "=", "failed")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /**
   * CANCEL every pre-ready state, INCLUDING 'processing'. Cancelling
   * mid-transcode is safe: the worker's guarded heartbeat (WHERE
   * status = 'processing') returns 0 rows, fires its AbortController and kills
   * the in-flight ffmpeg within one heartbeat interval; every terminal worker
   * write is equally guarded, so nothing resurrects the cancelled row.
   */
  async cancel(id: string, trx?: Trx): Promise<boolean> {
    const res = await (trx || getDb())
      .updateTable("videos")
      .set({ status: "cancelled", updated_at: new Date() })
      .where("id", "=", id)
      .where("status", "in", [...NON_TERMINAL, "failed"])
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  async softDelete(id: string, trx?: Trx): Promise<boolean> {
    const res = await (trx || getDb())
      .updateTable("videos")
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  async renditions(videoId: string): Promise<RenditionRow[]> {
    return getDb()
      .selectFrom("video_renditions")
      .selectAll()
      .where("video_id", "=", videoId)
      .orderBy("height", "desc")
      .execute();
  }

  /** Catalog + storage + queue numbers for the dashboard, in one round trip. */
  async stats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    sourceBytes: number;
    outputBytes: number;
    jobsQueued: number;
    jobsProcessing: number;
    activeSessions: number;
  }> {
    const res = await sql<{
      status: string | null;
      n: string;
      source_bytes: string | null;
      output_bytes: string | null;
    }>`
      SELECT status::text AS status, count(*) AS n,
             sum(source_bytes) AS source_bytes, sum(output_bytes) AS output_bytes
      FROM videos WHERE deleted_at IS NULL
      GROUP BY ROLLUP (status)
    `.execute(getDb());
    const extra = await sql<{ jobs_queued: number; jobs_processing: number; active_sessions: number }>`
      SELECT
        (SELECT count(*) FROM jobs WHERE status = 'queued')::int     AS jobs_queued,
        (SELECT count(*) FROM jobs WHERE status = 'processing')::int AS jobs_processing,
        (SELECT count(*) FROM playback_sessions WHERE revoked_at IS NULL AND expires_at > now())::int AS active_sessions
    `.execute(getDb());

    const byStatus: Record<string, number> = {
      uploading: 0,
      uploaded: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      cancelled: 0,
    };
    let total = 0;
    let sourceBytes = 0;
    let outputBytes = 0;
    for (const r of res.rows) {
      if (r.status === null) {
        total = toNumber(r.n);
        sourceBytes = toNumber(r.source_bytes);
        outputBytes = toNumber(r.output_bytes);
      } else {
        byStatus[r.status] = toNumber(r.n);
      }
    }
    const e = extra.rows[0];
    return {
      total,
      byStatus,
      sourceBytes,
      outputBytes,
      jobsQueued: e?.jobs_queued ?? 0,
      jobsProcessing: e?.jobs_processing ?? 0,
      activeSessions: e?.active_sessions ?? 0,
    };
  }
}

export default new VideosRepository();
