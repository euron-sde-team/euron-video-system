import { getWorkerConfig } from "@evs/core/config";
import logger from "@evs/core/logger";
import { heartbeat } from "@evs/core/queue";

/**
 * Keeps `heartbeat_at` fresh during long ffmpeg runs so the reaper (10-minute
 * stale window) doesn't reclaim a video that is actually progressing. Also
 * carries the current stage + progress for the console.
 *
 * If a periodic heartbeat matches zero rows, this worker has LOST ownership (the
 * video was reaped, cancelled, retried, or re-claimed). We flag it AND fire
 * `onLost` once, which the worker wires to an AbortController so the running
 * ffmpeg is killed immediately instead of wasting an hour on a doomed job. A
 * heartbeat that THROWS (transient DB blip) is NOT treated as lost; only a
 * successful update returning 0 rows is, so a network hiccup never aborts a
 * live job.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private stage = "transcoding";
  private progress = 0;
  private lost = false;

  constructor(
    private readonly videoId: string,
    private readonly workerId: string,
    private readonly onLost?: () => void
  ) {}

  /** Flag lost ownership + fire onLost exactly once. */
  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    logger.warn(`[heartbeat ${this.videoId}] lost ownership (reaped/cancelled/retried/reclaimed)`);
    this.onLost?.();
  }

  start(): void {
    this.timer = setInterval(() => {
      void heartbeat(this.videoId, this.workerId, this.stage, this.progress)
        .then((owned) => {
          if (!owned) this.markLost();
        })
        // A thrown heartbeat (DB blip) is transient, NOT a lost claim: warn only.
        .catch((e) => logger.warn(`[heartbeat ${this.videoId}] ${e}`));
    }, getWorkerConfig().HEARTBEAT_MS);
  }

  /** Set stage + progress at a stage boundary and persist immediately. */
  async update(stage: string, progress: number): Promise<void> {
    this.stage = stage;
    this.progress = progress;
    const owned = await heartbeat(this.videoId, this.workerId, stage, progress);
    if (!owned) this.markLost();
  }

  get lostOwnership(): boolean {
    return this.lost;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
