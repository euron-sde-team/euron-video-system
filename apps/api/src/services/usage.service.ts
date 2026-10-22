import logger from "@evs/core/logger";
import usageRepository from "../repositories/usage.repository.js";
import { toNumber } from "@evs/core/db";

/**
 * Daily usage rollups.
 *
 * Key deliveries happen once per variant switch per viewer, which is far too
 * hot to UPSERT per request. They are counted in memory and flushed every
 * FLUSH_MS (and on shutdown), turning thousands of writes into one. A crash
 * loses at most one interval of a metering counter, never security state.
 */
const FLUSH_MS = 10_000;

class UsageService {
  private pendingKeyDeliveries = 0;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  countKeyDelivery(): void {
    this.pendingKeyDeliveries++;
  }

  async flush(): Promise<void> {
    const n = this.pendingKeyDeliveries;
    if (n === 0) return;
    this.pendingKeyDeliveries = 0;
    try {
      await usageRepository.increment("key_deliveries", n);
    } catch (err) {
      this.pendingKeyDeliveries += n; // retry next tick
      logger.warn("usage flush failed", { err: (err as Error).message });
    }
  }

  async range(from: string, to: string): Promise<{
    days: Array<{ day: string; videosCreated: number; transcodeSeconds: number; playbackSessions: number; keyDeliveries: number }>;
    totals: { videosCreated: number; transcodeSeconds: number; playbackSessions: number; keyDeliveries: number };
  }> {
    const rows = await usageRepository.range(from, to);
    const days = rows.map((r) => ({
      day: r.day,
      videosCreated: r.videos_created,
      transcodeSeconds: toNumber(r.transcode_seconds),
      playbackSessions: r.playback_sessions,
      keyDeliveries: r.key_deliveries,
    }));
    const totals = days.reduce(
      (t, d) => ({
        videosCreated: t.videosCreated + d.videosCreated,
        transcodeSeconds: t.transcodeSeconds + d.transcodeSeconds,
        playbackSessions: t.playbackSessions + d.playbackSessions,
        keyDeliveries: t.keyDeliveries + d.keyDeliveries,
      }),
      { videosCreated: 0, transcodeSeconds: 0, playbackSessions: 0, keyDeliveries: 0 }
    );
    return { days, totals };
  }
}

export default new UsageService();
