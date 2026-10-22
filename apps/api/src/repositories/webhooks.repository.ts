import { sql } from "kysely";
import { getDb, toNumber, type Row } from "@evs/core/db";

export type EndpointRow = Row<"webhook_endpoints">;
export type DeliveryRow = Row<"webhook_deliveries">;

class WebhooksRepository {
  // ─── Endpoints ───────────────────────────────────────────────────────────

  async createEndpoint(input: {
    id: string;
    url: string;
    description: string | null;
    events: string[];
    secretCiphertext: string;
  }): Promise<EndpointRow> {
    return getDb()
      .insertInto("webhook_endpoints")
      .values({
        id: input.id,
        url: input.url,
        description: input.description,
        events: input.events,
        secret_ciphertext: input.secretCiphertext,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listEndpoints(): Promise<EndpointRow[]> {
    return getDb().selectFrom("webhook_endpoints").selectAll().orderBy("created_at", "desc").execute();
  }

  async findEndpoint(id: string): Promise<EndpointRow | null> {
    return (await getDb().selectFrom("webhook_endpoints").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  async updateEndpoint(
    id: string,
    patch: { url?: string; description?: string | null; events?: string[]; enabled?: boolean }
  ): Promise<EndpointRow | null> {
    return (
      (await getDb()
        .updateTable("webhook_endpoints")
        .set({ ...patch, updated_at: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const res = await getDb().deleteFrom("webhook_endpoints").where("id", "=", id).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }

  // ─── Deliveries ──────────────────────────────────────────────────────────

  async insertDelivery(input: {
    id: string;
    endpointId: string;
    eventId: string;
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    await getDb()
      .insertInto("webhook_deliveries")
      .values({
        id: input.id,
        endpoint_id: input.endpointId,
        event_id: input.eventId,
        event_type: input.eventType,
        payload: JSON.stringify(input.payload),
      })
      .execute();
  }

  async listDeliveries(endpointId: string, page: number, limit: number): Promise<{ rows: DeliveryRow[]; total: number }> {
    const base = getDb().selectFrom("webhook_deliveries").where("endpoint_id", "=", endpointId);
    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset((page - 1) * limit)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirst(),
    ]);
    return { rows, total: toNumber(count?.n) };
  }

  async findDelivery(id: string): Promise<DeliveryRow | null> {
    return (await getDb().selectFrom("webhook_deliveries").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  /**
   * Re-arm a delivery (any status) for immediate redelivery, keeping its event
   * id. `now()` comes from the database, never the app host: due-ness is
   * compared against the database clock, and the two can drift apart.
   */
  async rearm(id: string): Promise<boolean> {
    const res = await getDb()
      .updateTable("webhook_deliveries")
      .set({ status: "pending", attempts: 0, next_attempt_at: sql<Date>`now()`, locked_by: null, locked_at: null, last_error: null })
      .where("id", "=", id)
      .where("status", "!=", "delivering")
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  // ─── Dispatcher queue mechanics (same SKIP LOCKED pattern as the video queue) ──

  /** Claim up to `limit` due deliveries, joined with their endpoint. */
  async claimDue(
    workerId: string,
    limit: number
  ): Promise<Array<DeliveryRow & { url: string; secret_ciphertext: string; enabled: boolean }>> {
    const res = await sql<DeliveryRow & { url: string; secret_ciphertext: string; enabled: boolean }>`
      WITH due AS (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE webhook_deliveries d
      SET status = 'delivering', locked_by = ${workerId}, locked_at = now(), attempts = d.attempts + 1
      FROM due, webhook_endpoints e
      WHERE d.id = due.id AND e.id = d.endpoint_id
      RETURNING d.*, e.url, e.secret_ciphertext, e.enabled
    `.execute(getDb());
    return res.rows;
  }

  async markDelivered(id: string, workerId: string, statusCode: number): Promise<void> {
    await getDb()
      .updateTable("webhook_deliveries")
      .set({ status: "delivered", delivered_at: new Date(), last_status_code: statusCode, last_error: null, locked_by: null, locked_at: null })
      .where("id", "=", id)
      .where("locked_by", "=", workerId)
      .execute();
  }

  /** Failed attempt: schedule a retry, or go terminal once attempts are exhausted. */
  async markAttemptFailed(
    id: string,
    workerId: string,
    result: { statusCode: number | null; error: string; delayMs: number }
  ): Promise<void> {
    await sql`
      UPDATE webhook_deliveries SET
        status = (CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END)::webhook_delivery_status,
        next_attempt_at = now() + ${`${result.delayMs} milliseconds`}::interval,
        last_status_code = ${result.statusCode},
        last_error = ${result.error.slice(0, 1000)},
        locked_by = NULL, locked_at = NULL
      WHERE id = ${id} AND locked_by = ${workerId}
    `.execute(getDb());
  }

  /** A dispatcher that died mid-delivery leaves rows 'delivering'; give them back. */
  async reapStale(): Promise<number> {
    const res = await sql`
      UPDATE webhook_deliveries SET status = 'pending', locked_by = NULL, locked_at = NULL
      WHERE status = 'delivering' AND locked_at < now() - interval '5 minutes'
    `.execute(getDb());
    return Number(res.numAffectedRows ?? 0n);
  }
}

export default new WebhooksRepository();
