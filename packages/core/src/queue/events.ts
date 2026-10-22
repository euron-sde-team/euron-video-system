import { sql, type Kysely } from "kysely";
import { ulid } from "ulid";
import type { DB } from "../db/types.js";

/** Every event a webhook endpoint can subscribe to. */
export const EVENT_TYPES = [
  "video.created",
  "video.uploaded",
  "video.ready",
  "video.failed",
  "video.cancelled",
  "video.deleted",
  "captions.ready",
  "download.ready",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  createdAt: string;
  data: T;
}

/**
 * Transactional outbox write. Inserts one webhook_deliveries row per enabled
 * endpoint subscribed to `type`, in the CALLER's transaction. The state change
 * (e.g. video -> ready) and the intent to notify therefore commit or roll back
 * together: no lost events, no events for changes that never happened. The
 * dispatcher (apps/api/src/webhooks) delivers them asynchronously with retries.
 *
 * Returns the number of deliveries queued (0 when nobody is subscribed).
 */
export const emitEvent = async (
  db: Kysely<DB>,
  type: EventType,
  data: Record<string, unknown>
): Promise<number> => {
  const envelope: EventEnvelope = { id: `evt_${ulid()}`, type, createdAt: new Date().toISOString(), data };
  // One INSERT ... SELECT: no read-then-write race with endpoint changes, and no
  // N+1 over endpoints. Per-row ids come from the event id + endpoint id, which
  // are already unique together (UNIQUE (endpoint_id, event_id)).
  const res = await sql`
    INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload)
    SELECT ${envelope.id} || '_' || e.id, e.id, ${envelope.id}, ${type}, ${JSON.stringify(envelope)}::jsonb
    FROM webhook_endpoints e
    WHERE e.enabled AND (${type} = ANY (e.events) OR '*' = ANY (e.events))
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
  `.execute(db);
  return Number(res.numAffectedRows ?? 0n);
};
