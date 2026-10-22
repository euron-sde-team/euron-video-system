import { sql } from "kysely";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../../../../tests/integration/db.js";
import { closeDatabase, getDb } from "../../src/db/index.js";
import {
  JOB_CANCEL_SQL,
  JOB_RECONCILE_SQL,
  claimNext,
  claimNextJob,
  emitEvent,
  failOrRequeue,
  failOrRequeueJob,
  heartbeat,
  jobHeartbeat,
  markReadyAndEnqueue,
  releaseClaim,
  reapStale,
} from "../../src/queue/index.js";

const db = () => getDb();

const insertVideo = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const id = ulid();
  await db()
    .insertInto("videos")
    .values({ id, title: `video ${id}`, status: "uploaded", ...overrides })
    .execute();
  return id;
};

const getVideo = (id: string) => db().selectFrom("videos").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const readyResult = {
  outputBytes: 1234,
  durationSeconds: 61.4,
  renditions: [
    { label: "720", width: 1280, height: 720, bitrateKbps: 2800, codec: "avc1.64001f" },
    { label: "480", width: 854, height: 480, bitrateKbps: 1400, codec: "avc1.64001e" },
  ],
  enqueueCaptions: true,
  enqueueDownload: true,
};

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe("claim", () => {
  it("returns null on an empty queue", async () => {
    expect(await claimNext("w1")).toBeNull();
  });

  it("claims the oldest uploaded video and stamps ownership", async () => {
    const older = await insertVideo({ created_at: new Date(Date.now() - 60_000) });
    await insertVideo();
    const claimed = await claimNext("w1");
    expect(claimed?.id).toBe(older);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.locked_by).toBe("w1");
    expect(claimed?.attempts).toBe(1);
  });

  it("never hands the same video to two concurrent workers", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => insertVideo()));
    // 25 workers race for 10 rows on separate pool connections.
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => claimNext(`w${i}`)));
    const claimed = results.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.id);
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed).size).toBe(10);
    expect(new Set(claimed)).toEqual(new Set(ids));
  });
});

describe("guarded writes", () => {
  it("heartbeat succeeds only for the owner", async () => {
    const id = await insertVideo();
    await claimNext("owner");
    expect(await heartbeat(id, "owner", "packaging", 50)).toBe(true);
    expect(await heartbeat(id, "intruder", "packaging", 99)).toBe(false);
    const row = await getVideo(id);
    expect(row.stage).toBe("packaging");
    expect(row.progress).toBe(50);
  });

  it("a cancelled video's heartbeat fails, telling the worker to abort", async () => {
    const id = await insertVideo();
    await claimNext("w1");
    await db().updateTable("videos").set({ status: "cancelled" }).where("id", "=", id).execute();
    expect(await heartbeat(id, "w1", "transcoding", 10)).toBe(false);
  });

  it("a worker that lost its claim cannot mark the video ready", async () => {
    const id = await insertVideo();
    await claimNext("w1");
    // The reaper (or a cancel) took the row away from w1, and w2 now owns it.
    await db().updateTable("videos").set({ locked_by: "w2" }).where("id", "=", id).execute();
    expect(await markReadyAndEnqueue(id, "w1", readyResult)).toBe(false);
    expect((await getVideo(id)).status).toBe("processing");
    const jobs = await db().selectFrom("jobs").selectAll().execute();
    expect(jobs).toHaveLength(0);
  });
});

describe("markReadyAndEnqueue", () => {
  it("flips ready, records renditions, queues jobs, meters usage and emits an event atomically", async () => {
    await db()
      .insertInto("webhook_endpoints")
      .values({ id: "wh_1", url: "https://hooks.example.com/evs", events: ["video.ready"], secret_ciphertext: "x" })
      .execute();
    const id = await insertVideo();
    await claimNext("w1");

    expect(await markReadyAndEnqueue(id, "w1", readyResult)).toBe(true);

    const video = await getVideo(id);
    expect(video.status).toBe("ready");
    expect(video.progress).toBe(100);
    expect(video.duration_seconds).toBe(61);
    expect(video.captions_status).toBe("pending");
    expect(video.mp4_status).toBe("pending");

    const renditions = await db().selectFrom("video_renditions").select("label").where("video_id", "=", id).execute();
    expect(renditions.map((r) => r.label).sort()).toEqual(["480", "720"]);

    const jobs = await db().selectFrom("jobs").select(["kind", "status"]).where("video_id", "=", id).execute();
    expect(jobs.map((j) => j.kind).sort()).toEqual(["CAPTIONS", "DOWNLOAD"]);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);

    const usage = await db().selectFrom("usage_daily").selectAll().executeTakeFirstOrThrow();
    expect(Number(usage.transcode_seconds)).toBe(61);

    const deliveries = await db().selectFrom("webhook_deliveries").selectAll().execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.event_type).toBe("video.ready");
    expect((deliveries[0]?.payload as { data: { videoId: string } }).data.videoId).toBe(id);
  });

  it("marks artifacts skipped when they are not requested", async () => {
    const id = await insertVideo();
    await claimNext("w1");
    await markReadyAndEnqueue(id, "w1", { ...readyResult, enqueueCaptions: false, enqueueDownload: false });
    const video = await getVideo(id);
    expect(video.captions_status).toBe("skipped");
    expect(video.mp4_status).toBe("skipped");
    expect(await db().selectFrom("jobs").selectAll().execute()).toHaveLength(0);
  });
});

describe("failure, retry and the reaper", () => {
  it("requeues below max_attempts and goes terminal (with video.failed) at max_attempts", async () => {
    await db()
      .insertInto("webhook_endpoints")
      .values({ id: "wh_1", url: "https://hooks.example.com/evs", events: ["*"], secret_ciphertext: "x" })
      .execute();
    const id = await insertVideo({ max_attempts: 2 });

    await claimNext("w1");
    await failOrRequeue(id, "w1", "ffmpeg exited 1");
    expect((await getVideo(id)).status).toBe("uploaded");

    await claimNext("w1");
    await failOrRequeue(id, "w1", "ffmpeg exited 1");
    const video = await getVideo(id);
    expect(video.status).toBe("failed");
    expect(video.error).toBe("ffmpeg exited 1");
    // Artifacts that will never be produced are resolved, not left "pending".
    expect(video.captions_status).toBe("skipped");
    expect(video.mp4_status).toBe("skipped");

    const events = await db().selectFrom("webhook_deliveries").select("event_type").execute();
    expect(events.map((e) => e.event_type)).toEqual(["video.failed"]);
  });

  it("a Spot interruption releases the claim without consuming an attempt", async () => {
    const id = await insertVideo();
    await claimNext("w1");
    await releaseClaim(id, "w1");
    const video = await getVideo(id);
    expect(video.status).toBe("uploaded");
    expect(video.attempts).toBe(0);
    expect(video.locked_by).toBeNull();
  });

  it("the reaper requeues a video whose heartbeat went stale", async () => {
    const id = await insertVideo();
    await claimNext("w1");
    await sql`UPDATE videos SET heartbeat_at = now() - interval '11 minutes' WHERE id = ${id}`.execute(db());
    expect(await reapStale()).toBe(1);
    const video = await getVideo(id);
    expect(video.status).toBe("uploaded");
    expect(video.locked_by).toBeNull();
  });

  it("a reaper hard-fail at max_attempts also resolves pending artifacts", async () => {
    const id = await insertVideo({ max_attempts: 1 });
    await claimNext("w1");
    await sql`UPDATE videos SET heartbeat_at = now() - interval '11 minutes' WHERE id = ${id}`.execute(db());
    expect(await reapStale()).toBe(1);
    const video = await getVideo(id);
    expect(video.status).toBe("failed");
    expect(video.error).toBe("max attempts exceeded");
    expect(video.captions_status).toBe("skipped");
    expect(video.mp4_status).toBe("skipped");
  });

  it("the reaper leaves healthy claims alone", async () => {
    await insertVideo();
    await claimNext("w1");
    expect(await reapStale()).toBe(0);
  });
});

describe("background jobs", () => {
  const readyVideoWithJobs = async (): Promise<string> => {
    const id = await insertVideo();
    await claimNext("w1");
    await markReadyAndEnqueue(id, "w1", readyResult);
    return id;
  };

  it("never claims jobs of a cancelled video, and JOB_CANCEL_SQL retires them", async () => {
    const id = await readyVideoWithJobs();
    await db().updateTable("videos").set({ status: "cancelled" }).where("id", "=", id).execute();
    expect(await claimNextJob("w2")).toBeNull();
    await sql.raw(JOB_CANCEL_SQL).execute(db());
    const statuses = await db().selectFrom("jobs").select("status").execute();
    expect(statuses.every((s) => s.status === "cancelled")).toBe(true);
  });

  it("job heartbeat fails once the parent video is cancelled", async () => {
    const id = await readyVideoWithJobs();
    const job = await claimNextJob("w2");
    expect(job).not.toBeNull();
    expect(await jobHeartbeat(job!.id, "w2")).toBe(true);
    await db().updateTable("videos").set({ status: "cancelled" }).where("id", "=", id).execute();
    expect(await jobHeartbeat(job!.id, "w2")).toBe(false);
  });

  it("a terminally failed job flips the matching artifact status", async () => {
    const id = await readyVideoWithJobs();
    await db().updateTable("jobs").set({ max_attempts: 1 }).execute();
    let job = await claimNextJob("w2");
    while (job && job.kind !== "DOWNLOAD") {
      await failOrRequeueJob(job, "w2", "skip");
      job = await claimNextJob("w2");
    }
    expect(job?.kind).toBe("DOWNLOAD");
    await failOrRequeueJob(job!, "w2", "disk full");
    expect((await getVideo(id)).mp4_status).toBe("failed");
  });

  it("JOB_RECONCILE_SQL repairs artifact status after a reaper hard-fail", async () => {
    const id = await readyVideoWithJobs();
    await db().updateTable("jobs").set({ status: "failed" }).where("kind", "=", "CAPTIONS").execute();
    await sql.raw(JOB_RECONCILE_SQL).execute(db());
    expect((await getVideo(id)).captions_status).toBe("failed");
  });
});

describe("outbox and audit invariants", () => {
  it("emitEvent fans out only to enabled, subscribed endpoints", async () => {
    await db()
      .insertInto("webhook_endpoints")
      .values([
        { id: "wh_all", url: "https://a.example.com", events: ["*"], secret_ciphertext: "x" },
        { id: "wh_ready", url: "https://b.example.com", events: ["video.ready"], secret_ciphertext: "x" },
        { id: "wh_failed", url: "https://c.example.com", events: ["video.failed"], secret_ciphertext: "x" },
        { id: "wh_off", url: "https://d.example.com", events: ["*"], secret_ciphertext: "x", enabled: false },
      ])
      .execute();
    expect(await emitEvent(db(), "video.ready", { videoId: "v1" })).toBe(2);
    const targets = await db().selectFrom("webhook_deliveries").select("endpoint_id").orderBy("endpoint_id").execute();
    expect(targets.map((t) => t.endpoint_id)).toEqual(["wh_all", "wh_ready"]);
  });

  it("the audit log rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    await db()
      .insertInto("audit_events")
      .values({ id: ulid(), actor_type: "system", action: "test.write", resource_type: "test" })
      .execute();
    await expect(sql`UPDATE audit_events SET action = 'tampered'`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_events`.execute(db())).rejects.toThrow(/append-only/);
  });

  it("allows exactly one default playback policy", async () => {
    await expect(
      db().insertInto("playback_policies").values({ id: ulid(), name: "second", is_default: true }).execute()
    ).rejects.toThrow(/playback_policies_one_default/);
  });
});
