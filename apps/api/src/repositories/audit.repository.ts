import { getDb, type ActorType, type Row } from "@evs/core/db";

export type AuditRow = Row<"audit_events">;

class AuditRepository {
  async insert(input: {
    id: string;
    actorType: ActorType;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    ipHash: string | null;
    requestId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await getDb()
      .insertInto("audit_events")
      .values({
        id: input.id,
        actor_type: input.actorType,
        actor_id: input.actorId,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        ip_hash: input.ipHash,
        request_id: input.requestId,
        metadata: JSON.stringify(input.metadata),
      })
      .execute();
  }

  /**
   * Keyset pagination, newest first. Ids are ULIDs, so ordering by id is
   * ordering by time, and `id < cursor` is a stable, index-friendly cursor
   * that never skips or repeats rows while new events are being appended.
   */
  async list(params: {
    action?: string;
    resourceType?: string;
    resourceId?: string;
    cursor?: string;
    limit: number;
  }): Promise<AuditRow[]> {
    let q = getDb().selectFrom("audit_events").selectAll();
    if (params.action) q = q.where("action", "=", params.action);
    if (params.resourceType) q = q.where("resource_type", "=", params.resourceType);
    if (params.resourceId) q = q.where("resource_id", "=", params.resourceId);
    if (params.cursor) q = q.where("id", "<", params.cursor);
    return q.orderBy("id", "desc").limit(params.limit).execute();
  }
}

export default new AuditRepository();
