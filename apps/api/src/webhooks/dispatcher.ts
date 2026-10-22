import { hostname } from "node:os";
import { getApiConfig } from "@evs/core/config";
import logger from "@evs/core/logger";
import webhooksRepository from "../repositories/webhooks.repository.js";
import { enforceWebhookSsrf, openSigningSecret } from "../services/webhooks.service.js";
import { webhookDeliveries } from "../metrics.js";
import { nextRetryDelay } from "./retry.js";
import { signPayload } from "./signature.js";
import { assertSafeWebhookUrl } from "./ssrf.js";

/**
 * Webhook dispatcher: drains the webhook_deliveries outbox.
 *
 * It runs inside every API process (and every cluster worker). Claims use the
 * same `FOR UPDATE SKIP LOCKED` pattern as the video queue, so any number of
 * dispatchers cooperate without double delivery. Delivery is at-least-once:
 * receivers dedupe on the EVS-Event-Id header, which is stable across retries.
 */
const BATCH = 10;
const IDLE_POLL_MS = 2_000;

export class WebhookDispatcher {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly workerId = `${hostname()}:${process.pid}`;
  private lastReap = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    logger.info("webhook dispatcher started");
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const n = await this.tick();
        if (n === 0) await new Promise((r) => setTimeout(r, IDLE_POLL_MS).unref());
      } catch (err) {
        logger.error("webhook dispatcher tick failed", { err: (err as Error).message });
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS * 2).unref());
      }
    }
  }

  /** One pass: reap stale locks (rarely), claim a batch, deliver it. Returns deliveries attempted. */
  async tick(): Promise<number> {
    if (Date.now() - this.lastReap > 60_000) {
      this.lastReap = Date.now();
      await webhooksRepository.reapStale();
    }
    const batch = await webhooksRepository.claimDue(this.workerId, BATCH);
    await Promise.all(batch.map((d) => this.deliver(d)));
    return batch.length;
  }

  private async deliver(d: Awaited<ReturnType<typeof webhooksRepository.claimDue>>[number]): Promise<void> {
    const timeoutMs = getApiConfig().WEBHOOK_TIMEOUT_MS;
    const fail = async (statusCode: number | null, error: string): Promise<void> => {
      await webhooksRepository.markAttemptFailed(d.id, this.workerId, {
        statusCode,
        error,
        delayMs: nextRetryDelay(d.attempts),
      });
      webhookDeliveries.inc({ outcome: "failed" });
      logger.warn("webhook delivery failed", { deliveryId: d.id, attempt: d.attempts, statusCode, error });
    };

    if (!d.enabled) return fail(null, "endpoint disabled");
    try {
      // Re-checked per delivery: DNS may have changed since registration (rebinding).
      await assertSafeWebhookUrl(d.url, enforceWebhookSsrf());
    } catch (err) {
      return fail(null, (err as Error).message);
    }

    const body = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let res: Response;
    try {
      res = await fetch(d.url, {
        method: "POST",
        redirect: "manual", // a redirect could point anywhere, including the VPC
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "EVS-Webhooks/1",
          "EVS-Event-Id": d.event_id,
          "EVS-Event-Type": d.event_type,
          "EVS-Delivery-Id": d.id,
          "EVS-Signature": signPayload(openSigningSecret(d.endpoint_id, d.secret_ciphertext), body, timestamp),
        },
        body,
      });
    } catch (err) {
      return fail(null, (err as Error).name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : (err as Error).message);
    }
    // Drain the body so the socket is reusable; we never trust its content.
    await res.arrayBuffer().catch(() => undefined);

    if (res.status >= 200 && res.status < 300) {
      await webhooksRepository.markDelivered(d.id, this.workerId, res.status);
      webhookDeliveries.inc({ outcome: "delivered" });
      return;
    }
    return fail(res.status, `HTTP ${res.status}`);
  }
}

export default new WebhookDispatcher();
