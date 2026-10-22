import { ulid } from "ulid";
import logger, { redact } from "@evs/core/logger";
import auditRepository, { type AuditRow } from "../repositories/audit.repository.js";
import { iso } from "../http/pagination.js";
import type { Actor } from "./actor.js";

export interface AuditEventResponse {
  id: string;
  actor: { type: string; id: string | null };
  action: string;
  resource: { type: string; id: string | null };
  requestId: string | null;
  metadata: unknown;
  createdAt: string | null;
}

const toResponse = (r: AuditRow): AuditEventResponse => ({
  id: r.id,
  actor: { type: r.actor_type, id: r.actor_id },
  action: r.action,
  resource: { type: r.resource_type, id: r.resource_id },
  requestId: r.request_id,
  metadata: r.metadata,
  createdAt: iso(r.created_at),
});

/**
 * Append-only audit trail of every state-changing control-plane action.
 *
 * Recording happens AFTER the mutation commits and never throws: an audit
 * write failing (database blip) must not turn a successful operation into an
 * error the caller retries. Failures are logged loudly instead. Metadata is
 * passed through the logger's redactor so secrets cannot land in the trail.
 */
class AuditService {
  async record(
    actor: Actor,
    action: string,
    resource: { type: string; id: string | null },
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await auditRepository.insert({
        id: ulid(),
        actorType: actor.type,
        actorId: actor.id,
        action,
        resourceType: resource.type,
        resourceId: resource.id,
        ipHash: actor.ipHash,
        requestId: actor.requestId,
        metadata: redact(metadata) as Record<string, unknown>,
      });
    } catch (err) {
      logger.error("audit write failed", { action, resourceId: resource.id, err: (err as Error).message });
    }
  }

  async list(params: {
    action?: string;
    resourceType?: string;
    resourceId?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ data: AuditEventResponse[]; nextCursor: string | null }> {
    const rows = await auditRepository.list(params);
    const last = rows[rows.length - 1];
    return { data: rows.map(toResponse), nextCursor: rows.length === params.limit && last ? last.id : null };
  }
}

export default new AuditService();
