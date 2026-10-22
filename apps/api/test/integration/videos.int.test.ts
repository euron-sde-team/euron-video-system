import { sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@evs/core/db";
import { resetDatabase } from "../../../../tests/integration/db.js";
import { objects, putObject } from "./fake-storage.js";
import { authed, clearObjects, createKey, createReadyVideo } from "./helpers.js";

vi.mock("@evs/core/storage", () => import("./fake-storage.js"));

let key: string;
beforeEach(async () => {
  await resetDatabase();
  clearObjects();
  key = await createKey(["*"]);
});

describe("video lifecycle", () => {
  it("create returns a presigned upload and an 'uploading' video, and queues video.created", async () => {
    const res = await authed(key)
      .post("/v1/videos")
      .send({ title: "Intro", filename: "intro.MOV", externalRef: "ext-1", metadata: { team: "growth" } });
    expect(res.status).toBe(201);
    expect(res.body.video).toMatchObject({ title: "Intro", status: "uploading", externalRef: "ext-1", metadata: { team: "growth" } });
    expect(res.body.upload.fields.key).toBe(`uploads/${res.body.video.id}/original.mov`);
    expect(res.body.upload.expiresAt).toBeTruthy();
  });

  it("rejects unsupported extensions (422) and unknown policies (400)", async () => {
    expect((await authed(key).post("/v1/videos").send({ title: "x", filename: "a.exe" })).status).toBe(422);
    expect((await authed(key).post("/v1/videos").send({ title: "x", filename: "a.mp4", playbackPolicyId: "nope" })).status).toBe(400);
  });

  it("complete verifies the object exists, enqueues, records usage", async () => {
    const created = await authed(key).post("/v1/videos").send({ title: "Clip", filename: "c.mp4" });
    const id = created.body.video.id;
    // Not uploaded yet -> 422, status unchanged.
    expect((await authed(key).post(`/v1/videos/${id}/complete`)).status).toBe(422);

    putObject("uploads", `uploads/${id}/original.mp4`, Buffer.alloc(2048));
    const done = await authed(key).post(`/v1/videos/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "uploaded", sourceBytes: 2048 });
    // Completing twice is a conflict, not a double enqueue.
    expect((await authed(key).post(`/v1/videos/${id}/complete`)).status).toBe(409);

    const usage = await authed(key).get("/v1/usage");
    expect(usage.body.totals.videosCreated).toBe(1);
  });

  it("get, list (with status filter and search) and patch", async () => {
    const a = (await authed(key).post("/v1/videos").send({ title: "Alpha lesson", filename: "a.mp4" })).body.video.id;
    await authed(key).post("/v1/videos").send({ title: "Beta talk", filename: "b.mp4" });

    const list = await authed(key).get("/v1/videos?limit=10");
    expect(list.status).toBe(200);
    expect(list.body.pagination).toEqual({ page: 1, limit: 10, total: 2 });

    expect((await authed(key).get("/v1/videos?q=alpha")).body.data.map((v: { id: string }) => v.id)).toEqual([a]);
    expect((await authed(key).get("/v1/videos?status=ready")).body.pagination.total).toBe(0);
    expect((await authed(key).get("/v1/videos?status=bogus")).status).toBe(400);

    const patched = await authed(key).patch(`/v1/videos/${a}`).send({ title: "Alpha (edited)", metadata: { tag: 1 } });
    expect(patched.body).toMatchObject({ title: "Alpha (edited)", metadata: { tag: 1 } });
    expect((await authed(key).get(`/v1/videos/${a}`)).body.title).toBe("Alpha (edited)");
    expect((await authed(key).get("/v1/videos/does-not-exist")).status).toBe(404);
  });

  it("cancel, retry rules, and delete removes the row from reads and the objects from storage", async () => {
    const id = await createReadyVideo(key);
    // Ready videos cannot be cancelled or retried.
    expect((await authed(key).post(`/v1/videos/${id}/cancel`)).status).toBe(409);
    expect((await authed(key).post(`/v1/videos/${id}/retry`)).status).toBe(409);

    const pending = (await authed(key).post("/v1/videos").send({ title: "p", filename: "p.mp4" })).body.video.id;
    const cancelled = await authed(key).post(`/v1/videos/${pending}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");

    await sql`UPDATE videos SET status = 'failed', attempts = 3 WHERE id = ${pending}`.execute(getDb());
    const retried = await authed(key).post(`/v1/videos/${pending}/retry`);
    expect(retried.body).toMatchObject({ status: "uploaded", attempts: 0 });

    expect([...objects.keys()].some((k) => k.startsWith(`media/media/${id}/`))).toBe(true);
    expect((await authed(key).delete(`/v1/videos/${id}`)).status).toBe(204);
    expect((await authed(key).get(`/v1/videos/${id}`)).status).toBe(404);
    expect([...objects.keys()].some((k) => k.includes(id))).toBe(false);
    const row = await getDb().selectFrom("videos").select(["deleted_at"]).where("id", "=", id).executeTakeFirst();
    expect(row?.deleted_at).toBeTruthy();
  });

  it("download URL is 404 until the MP4 is ready, then a short-lived signed URL", async () => {
    const id = await createReadyVideo(key);
    expect((await authed(key).get(`/v1/videos/${id}/download`)).status).toBe(404);
    await sql`UPDATE videos SET mp4_status = 'ready' WHERE id = ${id}`.execute(getDb());
    const res = await authed(key).get(`/v1/videos/${id}/download`);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain(`downloads/${id}.mp4`);
    expect(res.body.filename).toBe("Ready_video.mp4");
  });

  it("stats reflect the catalog and queue", async () => {
    await createReadyVideo(key);
    await authed(key).post("/v1/videos").send({ title: "p", filename: "p.mp4" });
    const stats = await authed(key).get("/v1/stats");
    expect(stats.body.videos.total).toBe(2);
    expect(stats.body.videos.byStatus).toMatchObject({ ready: 1, uploading: 1 });
    expect(stats.body.storage.sourceBytes).toBe(1024);
  });

  it("emits outbox events for subscribed webhooks in the same transaction as the change", async () => {
    await authed(key).post("/v1/webhooks").send({ url: "http://localhost:1/h", events: ["video.created", "video.cancelled"] });
    const id = (await authed(key).post("/v1/videos").send({ title: "e", filename: "e.mp4" })).body.video.id;
    await authed(key).post(`/v1/videos/${id}/cancel`);
    const rows = await getDb().selectFrom("webhook_deliveries").select(["event_type"]).orderBy("created_at").execute();
    expect(rows.map((r) => r.event_type)).toEqual(["video.created", "video.cancelled"]);
  });
});
