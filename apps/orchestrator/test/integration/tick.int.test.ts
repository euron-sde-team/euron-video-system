import { randomUUID as ulid } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDb } from "@evs/core/db";
import { resetDatabase } from "../../../../tests/integration/db.js";
import { NoopLauncher, type WorkerPool } from "../../src/launcher.js";
import { runTick } from "../../src/tick.js";

/** NoopLauncher that records what the controller asked for. */
class RecordingLauncher extends NoopLauncher {
  calls: Array<{ count: number; pool: string }> = [];
  constructor(private readonly running = 0) {
    super();
  }
  override async countWorkers(): Promise<number> {
    return this.running;
  }
  override async launch(count: number, pool: WorkerPool): Promise<string[]> {
    this.calls.push({ count, pool: pool.roleTag });
    return [];
  }
}

const insertVideo = async (status: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = ulid();
  await getDb()
    .insertInto("videos")
    .values({ id, title: `t-${id}`, status: status as never, ...extra })
    .execute();
  return id;
};

// The noop launcher needs no EC2 launch template or subnets.
process.env.LAUNCHER = "noop";
const { getOrchestratorConfig } = await import("@evs/core/config");

describe("orchestrator tick (real database)", () => {
  const cfg = { ...getOrchestratorConfig(), LAUNCHER: "noop" as const, MAX_WORKERS: 3, DIVISOR: 1, JOBS_LAUNCH_TEMPLATE_NAME: undefined };

  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("launches one worker per queued video, capped by MAX_WORKERS", async () => {
    for (let i = 0; i < 5; i++) await insertVideo("uploaded");
    const launcher = new RecordingLauncher();
    const res = await runTick(launcher, cfg);
    expect(res).toMatchObject({ queued: 5, inProgress: 0, running: 0, toLaunch: 3, reaped: 0 });
    expect(launcher.calls).toEqual([{ count: 3, pool: cfg.WORKER_ROLE_TAG }]);
  });

  it("counts idle workers as spare and launches only the shortfall", async () => {
    await insertVideo("uploaded");
    await insertVideo("uploaded");
    await insertVideo("processing", { locked_by: "w1", locked_at: new Date(), heartbeat_at: new Date() });
    const launcher = new RecordingLauncher(2); // 2 running, 1 busy -> 1 spare
    const res = await runTick(launcher, cfg);
    expect(res).toMatchObject({ queued: 2, inProgress: 1, running: 2, spare: 1, toLaunch: 1 });
  });

  it("reaps a stale claim back to the queue before planning", async () => {
    const stale = new Date(Date.now() - 20 * 60_000);
    const id = await insertVideo("processing", { locked_by: "dead", locked_at: stale, heartbeat_at: stale, attempts: 1 });
    const res = await runTick(new RecordingLauncher(), cfg);
    expect(res.reaped).toBe(1);
    expect(res.queued).toBe(1);
    const row = await getDb().selectFrom("videos").select(["status", "locked_by"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "uploaded", locked_by: null });
  });

  it("fails a stale claim that is out of attempts instead of requeueing it", async () => {
    const stale = new Date(Date.now() - 20 * 60_000);
    const id = await insertVideo("processing", { locked_by: "dead", locked_at: stale, heartbeat_at: stale, attempts: 3, max_attempts: 3 });
    const res = await runTick(new RecordingLauncher(), cfg);
    expect(res).toMatchObject({ reaped: 1, queued: 0, toLaunch: 0 });
    const row = await getDb().selectFrom("videos").select(["status", "error"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "failed", error: "max attempts exceeded" });
  });

  it("retires queued jobs of cancelled videos so they never drive a launch", async () => {
    const videoId = await insertVideo("cancelled");
    await getDb().insertInto("jobs").values({ id: ulid(), video_id: videoId, kind: "CAPTIONS" }).execute();
    const launcher = new RecordingLauncher();
    const res = await runTick(launcher, cfg);
    expect(res).toMatchObject({ queued: 0, toLaunch: 0 });
    expect(launcher.calls).toEqual([]);
    const job = await getDb().selectFrom("jobs").select("status").where("video_id", "=", videoId).executeTakeFirstOrThrow();
    expect(job.status).toBe("cancelled");
  });

  it("plans the jobs pool separately when a jobs launch template is configured", async () => {
    const videoId = await insertVideo("ready");
    await getDb()
      .insertInto("jobs")
      .values([
        { id: ulid(), video_id: videoId, kind: "CAPTIONS" },
        { id: ulid(), video_id: videoId, kind: "DOWNLOAD" },
      ])
      .execute();
    await insertVideo("uploaded");
    const launcher = new RecordingLauncher();
    const res = await runTick(launcher, { ...cfg, JOBS_LAUNCH_TEMPLATE_NAME: "jobs-lt" });
    expect(res.toLaunch).toBe(3);
    expect(launcher.calls).toEqual([
      { count: 1, pool: cfg.WORKER_ROLE_TAG },
      { count: 2, pool: cfg.JOBS_ROLE_TAG },
    ]);
  });
});
