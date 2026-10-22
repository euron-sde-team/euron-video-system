import { getDb, type Row } from "@evs/core/db";

export type ApiKeyRow = Row<"api_keys">;

class ApiKeysRepository {
  async create(input: {
    id: string;
    name: string;
    prefix: string;
    keyHash: string;
    scopes: string[];
    createdBy: string | null;
    expiresAt: Date | null;
  }): Promise<ApiKeyRow> {
    return getDb()
      .insertInto("api_keys")
      .values({
        id: input.id,
        name: input.name,
        prefix: input.prefix,
        key_hash: input.keyHash,
        scopes: input.scopes,
        created_by: input.createdBy,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    return (await getDb().selectFrom("api_keys").selectAll().where("prefix", "=", prefix).executeTakeFirst()) ?? null;
  }

  async list(includeRevoked: boolean): Promise<ApiKeyRow[]> {
    let q = getDb().selectFrom("api_keys").selectAll();
    if (!includeRevoked) q = q.where("revoked_at", "is", null);
    return q.orderBy("created_at", "desc").execute();
  }

  async revoke(id: string): Promise<boolean> {
    const res = await getDb()
      .updateTable("api_keys")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /** Bump last_used_at at most once a minute per key (the WHERE makes it a cheap no-op otherwise). */
  async touch(id: string): Promise<void> {
    await getDb()
      .updateTable("api_keys")
      .set({ last_used_at: new Date() })
      .where("id", "=", id)
      .where((eb) =>
        eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", new Date(Date.now() - 60_000))])
      )
      .execute();
  }
}

export default new ApiKeysRepository();
