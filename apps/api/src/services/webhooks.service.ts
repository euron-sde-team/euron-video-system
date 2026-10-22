import { ulid } from "ulid";
import { getApiConfig, getCoreConfig } from "@evs/core/config";
import { randomToken, sealedSecrets } from "@evs/core/crypto";
import { BadRequestError, ConflictError, NotFoundError } from "@evs/core/errors";
import { EVENT_TYPES, type EventEnvelope } from "@evs/core/queue";
import { iso } from "../http/pagination.js";
import webhooksRepository, { type DeliveryRow, type EndpointRow } from "../repositories/webhooks.repository.js";
import { assertSafeWebhookUrl } from "../webhooks/ssrf.js";

export interface WebhookResponse {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeliveryResponse {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
}

const toResponse = (r: EndpointRow): WebhookResponse => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  enabled: r.enabled,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toDeliveryResponse = (r: DeliveryRow): DeliveryResponse => ({
  id: r.id,
  endpointId: r.endpoint_id,
  eventId: r.event_id,
  eventType: r.event_type,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  nextAttemptAt: iso(r.next_attempt_at),
  lastStatusCode: r.last_status_code,
  lastError: r.last_error,
  deliveredAt: iso(r.delivered_at),
  createdAt: iso(r.created_at),
});

const validateEvents = (events: string[]): string[] => {
  const unique = [...new Set(events)];
  const unknown = unique.filter((e) => e !== "*" && !(EVENT_TYPES as readonly string[]).includes(e));
  if (unknown.length) throw new BadRequestError(`Unknown event types: ${unknown.join(", ")}`, { allowed: [...EVENT_TYPES, "*"] });
  return unique;
};

/** Signing secrets are sealed with the endpoint id as AEAD context: a ciphertext copied between rows will not open. */
export const openSigningSecret = (endpointId: string, ciphertext: string): string =>
  sealedSecrets.open(ciphertext, `webhook:${endpointId}`);

/**
 * The SSRF guard is on in production unless a LOCAL demo explicitly opts out
 * (config refuses the opt-out when EVS_CLOUD=aws).
 */
export const enforceWebhookSsrf = (): boolean =>
  getCoreConfig().isProduction && !getApiConfig().WEBHOOK_ALLOW_PRIVATE_TARGETS;

class WebhooksService {
  private enforceSsrf(): boolean {
    return enforceWebhookSsrf();
  }

  async create(input: { url: string; events: string[]; description?: string | null }): Promise<
    WebhookResponse & { signingSecret: string }
  > {
    try {
      await assertSafeWebhookUrl(input.url, this.enforceSsrf());
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
    const id = `wh_${ulid()}`;
    const signingSecret = `whsec_${randomToken(32)}`;
    const row = await webhooksRepository.createEndpoint({
      id,
      url: input.url,
      description: input.description ?? null,
      events: validateEvents(input.events),
      secretCiphertext: sealedSecrets.seal(signingSecret, `webhook:${id}`),
    });
    return { ...toResponse(row), signingSecret };
  }

  async list(): Promise<WebhookResponse[]> {
    return (await webhooksRepository.listEndpoints()).map(toResponse);
  }

  async get(id: string): Promise<WebhookResponse> {
    const row = await webhooksRepository.findEndpoint(id);
    if (!row) throw new NotFoundError("Webhook endpoint not found");
    return toResponse(row);
  }

  async update(
    id: string,
    patch: { url?: string; events?: string[]; description?: string | null; enabled?: boolean }
  ): Promise<WebhookResponse> {
    if (patch.url) {
      try {
        await assertSafeWebhookUrl(patch.url, this.enforceSsrf());
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
    }
    const row = await webhooksRepository.updateEndpoint(id, {
      ...patch,
      ...(patch.events ? { events: validateEvents(patch.events) } : {}),
    });
    if (!row) throw new NotFoundError("Webhook endpoint not found");
    return toResponse(row);
  }

  async delete(id: string): Promise<void> {
    if (!(await webhooksRepository.deleteEndpoint(id))) throw new NotFoundError("Webhook endpoint not found");
  }

  /** Queue a synthetic `webhook.test` event to this endpoint only (bypasses subscriptions). */
  async test(id: string): Promise<DeliveryResponse> {
    const endpoint = await webhooksRepository.findEndpoint(id);
    if (!endpoint) throw new NotFoundError("Webhook endpoint not found");
    const eventId = `evt_${ulid()}`;
    const envelope: Omit<EventEnvelope, "type"> & { type: string } = {
      id: eventId,
      type: "webhook.test",
      createdAt: new Date().toISOString(),
      data: { endpointId: id, message: "This is a test event from Euron Video System." },
    };
    const deliveryId = `${eventId}_${id}`;
    await webhooksRepository.insertDelivery({ id: deliveryId, endpointId: id, eventId, eventType: envelope.type, payload: envelope });
    return toDeliveryResponse((await webhooksRepository.findDelivery(deliveryId)) as DeliveryRow);
  }

  async deliveries(endpointId: string, page: number, limit: number): Promise<{ rows: DeliveryResponse[]; total: number }> {
    if (!(await webhooksRepository.findEndpoint(endpointId))) throw new NotFoundError("Webhook endpoint not found");
    const { rows, total } = await webhooksRepository.listDeliveries(endpointId, page, limit);
    return { rows: rows.map(toDeliveryResponse), total };
  }

  async redeliver(deliveryId: string): Promise<DeliveryResponse> {
    const existing = await webhooksRepository.findDelivery(deliveryId);
    if (!existing) throw new NotFoundError("Webhook delivery not found");
    if (!(await webhooksRepository.rearm(deliveryId))) throw new ConflictError("Delivery is in flight; try again shortly");
    return toDeliveryResponse((await webhooksRepository.findDelivery(deliveryId)) as DeliveryRow);
  }
}

export default new WebhooksService();
