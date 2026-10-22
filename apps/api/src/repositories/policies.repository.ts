import { getDb, type Row, type Trx } from "@evs/core/db";

export type PolicyRow = Row<"playback_policies">;

export interface PolicyFields {
  name: string;
  tokenTtlSeconds: number;
  maxTokenTtlSeconds: number;
  allowedOrigins: string[];
  maxConcurrentSessions: number;
  watermarkRequired: boolean;
  allowDownload: boolean;
}

const toColumns = (f: Partial<PolicyFields>) => ({
  ...(f.name !== undefined ? { name: f.name } : {}),
  ...(f.tokenTtlSeconds !== undefined ? { token_ttl_seconds: f.tokenTtlSeconds } : {}),
  ...(f.maxTokenTtlSeconds !== undefined ? { max_token_ttl_seconds: f.maxTokenTtlSeconds } : {}),
  ...(f.allowedOrigins !== undefined ? { allowed_origins: f.allowedOrigins } : {}),
  ...(f.maxConcurrentSessions !== undefined ? { max_concurrent_sessions: f.maxConcurrentSessions } : {}),
  ...(f.watermarkRequired !== undefined ? { watermark_required: f.watermarkRequired } : {}),
  ...(f.allowDownload !== undefined ? { allow_download: f.allowDownload } : {}),
});

class PoliciesRepository {
  async list(): Promise<PolicyRow[]> {
    return getDb().selectFrom("playback_policies").selectAll().orderBy("is_default", "desc").orderBy("name").execute();
  }

  async findById(id: string, trx?: Trx): Promise<PolicyRow | null> {
    return (await (trx || getDb()).selectFrom("playback_policies").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  async findDefault(trx?: Trx): Promise<PolicyRow | null> {
    return (
      (await (trx || getDb()).selectFrom("playback_policies").selectAll().where("is_default", "=", true).executeTakeFirst()) ??
      null
    );
  }

  /** The policy governing a video: its own, else the default. */
  async effectiveFor(policyId: string | null): Promise<PolicyRow | null> {
    if (policyId) {
      const own = await this.findById(policyId);
      if (own) return own;
    }
    return this.findDefault();
  }

  async create(id: string, fields: PolicyFields, trx: Trx): Promise<PolicyRow> {
    return trx
      .insertInto("playback_policies")
      .values({ id, ...toColumns(fields), name: fields.name })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, fields: Partial<PolicyFields>, trx: Trx): Promise<PolicyRow | null> {
    return (
      (await trx
        .updateTable("playback_policies")
        .set({ ...toColumns(fields), updated_at: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }

  /**
   * Make `id` the default. Clearing the old default first, inside the same
   * transaction, keeps the partial unique index (one default) satisfied.
   */
  async setDefault(id: string, trx: Trx): Promise<void> {
    await trx.updateTable("playback_policies").set({ is_default: false }).where("is_default", "=", true).where("id", "!=", id).execute();
    await trx.updateTable("playback_policies").set({ is_default: true, updated_at: new Date() }).where("id", "=", id).execute();
  }

  async delete(id: string): Promise<boolean> {
    const res = await getDb()
      .deleteFrom("playback_policies")
      .where("id", "=", id)
      .where("is_default", "=", false)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }
}

export default new PoliciesRepository();
