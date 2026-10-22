import { getDb, toNumber, type Row, type Trx } from "@evs/core/db";

export type SessionRow = Row<"playback_sessions">;

class SessionsRepository {
  async create(
    input: {
      id: string;
      videoId: string;
      viewerId: string;
      policyId: string | null;
      origin: string | null;
      ipHash: string | null;
      userAgent: string | null;
      expiresAt: Date;
    },
    trx: Trx
  ): Promise<SessionRow> {
    return trx
      .insertInto("playback_sessions")
      .values({
        id: input.id,
        video_id: input.videoId,
        viewer_id: input.viewerId,
        policy_id: input.policyId,
        origin: input.origin,
        ip_hash: input.ipHash,
        user_agent: input.userAgent,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * A viewer's live sessions, OLDEST first, row-locked so two concurrent mints
   * for the same viewer serialise on the concurrency decision instead of both
   * seeing room for one more.
   */
  async activeForViewerForUpdate(viewerId: string, trx: Trx): Promise<SessionRow[]> {
    return trx
      .selectFrom("playback_sessions")
      .selectAll()
      .where("viewer_id", "=", viewerId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .orderBy("issued_at", "asc")
      .forUpdate()
      .execute();
  }

  async revokeMany(ids: string[], reason: string, trx?: Trx): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await (trx || getDb())
      .updateTable("playback_sessions")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("id", "in", ids)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n);
  }

  /** Revocation check on the hot delivery path: tiny projection, primary-key lookup. */
  async liveness(id: string): Promise<{ revoked: boolean; expiresAt: Date; videoId: string; policyId: string | null } | null> {
    const row = await getDb()
      .selectFrom("playback_sessions")
      .select(["revoked_at", "expires_at", "video_id", "policy_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    return row
      ? { revoked: row.revoked_at !== null, expiresAt: row.expires_at, videoId: row.video_id, policyId: row.policy_id }
      : null;
  }

  async findById(id: string): Promise<SessionRow | null> {
    return (await getDb().selectFrom("playback_sessions").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  async list(params: {
    videoId?: string;
    viewerId?: string;
    active?: boolean;
    page: number;
    limit: number;
  }): Promise<{ rows: SessionRow[]; total: number }> {
    let base = getDb().selectFrom("playback_sessions");
    if (params.videoId) base = base.where("video_id", "=", params.videoId);
    if (params.viewerId) base = base.where("viewer_id", "=", params.viewerId);
    if (params.active) base = base.where("revoked_at", "is", null).where("expires_at", ">", new Date());
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy("issued_at", "desc")
        .limit(params.limit)
        .offset((params.page - 1) * params.limit)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirst(),
    ]);
    return { rows, total: toNumber(count?.n) };
  }
}

export default new SessionsRepository();
