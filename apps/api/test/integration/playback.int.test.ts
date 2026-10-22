import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentKeyStore } from "@evs/core/crypto/store";
import { getDb } from "@evs/core/db";
import { resetDatabase } from "../../../../tests/integration/db.js";
import { authed, clearObjects, createKey, createReadyVideo, getApp, pathOf } from "./helpers.js";

vi.mock("@evs/core/storage", () => import("./fake-storage.js"));

let key: string;
beforeEach(async () => {
  await resetDatabase();
  clearObjects();
  key = await createKey(["*"]);
});

const mint = (videoId: string, body: Record<string, unknown> = { viewerId: "viewer-1" }) =>
  authed(key).post(`/v1/videos/${videoId}/playback-sessions`).send(body);

const createPolicy = async (fields: Record<string, unknown>) => {
  const res = await authed(key).post("/v1/playback-policies").send({ name: `p-${Math.random()}`, ...fields });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

describe("minting playback sessions", () => {
  it("refuses videos that are not ready", async () => {
    const id = (await authed(key).post("/v1/videos").send({ title: "x", filename: "x.mp4" })).body.video.id;
    expect((await mint(id)).status).toBe(422);
  });

  it("returns token, manifest/thumbnail/poster URLs and the watermark directive", async () => {
    const id = await createReadyVideo(key);
    const res = await mint(id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ watermark: { required: true, text: "viewer-1" } });
    expect(res.body.sessionId).toMatch(/^ps_/);
    expect(res.body.manifestUrl).toContain(`/v1/play/${id}/master.m3u8?token=`);
    expect(res.body.thumbnailsUrl).toContain("/thumbnails.vtt?token=");
  });

  it("clamps the TTL to the policy maximum", async () => {
    const pol = await createPolicy({ tokenTtlSeconds: 30, maxTokenTtlSeconds: 60 });
    const id = await createReadyVideo(key, { playbackPolicyId: pol });
    const res = await mint(id, { viewerId: "v", ttlSeconds: 3600 });
    const ttl = (Date.parse(res.body.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);
    const dflt = await mint(id, { viewerId: "v2" });
    expect((Date.parse(dflt.body.expiresAt) - Date.now()) / 1000).toBeLessThanOrEqual(30);
  });

  it("enforces the origin allowlist at mint time and at delivery time", async () => {
    const pol = await createPolicy({ allowedOrigins: ["https://app.example.com"] });
    const id = await createReadyVideo(key, { playbackPolicyId: pol });
    expect((await mint(id, { viewerId: "v" })).status).toBe(403);
    expect((await mint(id, { viewerId: "v", origin: "https://evil.example.net" })).status).toBe(403);
    const ok = await mint(id, { viewerId: "v", origin: "https://app.example.com" });
    expect(ok.status).toBe(201);

    const manifest = pathOf(ok.body.manifestUrl);
    expect((await request(getApp()).get(manifest).set("Origin", "https://app.example.com")).status).toBe(200);
    expect((await request(getApp()).get(manifest).set("Origin", "https://evil.example.net")).status).toBe(403);
  });

  it("evicts the oldest session when the concurrency limit is reached", async () => {
    const pol = await createPolicy({ maxConcurrentSessions: 1 });
    const id = await createReadyVideo(key, { playbackPolicyId: pol });
    const first = await mint(id, { viewerId: "same-viewer" });
    const second = await mint(id, { viewerId: "same-viewer" });
    expect(second.status).toBe(201);

    expect((await request(getApp()).get(pathOf(second.body.manifestUrl))).status).toBe(200);
    expect((await request(getApp()).get(pathOf(first.body.manifestUrl))).status).toBe(401);

    const sessions = await authed(key).get(`/v1/playback-sessions?videoId=${id}`);
    const revoked = sessions.body.data.find((s: { id: string }) => s.id === first.body.sessionId);
    expect(revoked).toMatchObject({ active: false, revokedReason: "concurrency_limit" });

    // A different viewer is unaffected by someone else's limit.
    expect((await mint(id, { viewerId: "other" })).status).toBe(201);
  });
});

describe("allowDownload policy", () => {
  const markMp4Ready = (id: string) =>
    getDb().updateTable("videos").set({ mp4_status: "ready" }).where("id", "=", id).execute();

  it("gives viewers a download URL only when the policy allows it and the MP4 is ready", async () => {
    // Default policy: allowDownload is false, so no URL even with the MP4 ready.
    const plain = await createReadyVideo(key);
    await markMp4Ready(plain);
    expect((await mint(plain)).body.downloadUrl).toBeNull();

    // Permissive policy, MP4 not produced yet: still no URL.
    const pol = await createPolicy({ allowDownload: true });
    const id = await createReadyVideo(key, { playbackPolicyId: pol });
    expect((await mint(id)).body.downloadUrl).toBeNull();

    // Permissive policy and MP4 ready: a presigned URL for exactly this video's MP4.
    await markMp4Ready(id);
    const res = await mint(id);
    expect(res.status).toBe(201);
    expect(res.body.downloadUrl).toContain(`downloads/${id}.mp4`);
  });
});

describe("token-gated delivery", () => {
  it("serves rewritten master and variant playlists and the raw key for a valid token", async () => {
    const id = await createReadyVideo(key);
    const stored = await contentKeyStore.generateAndStore(id);
    const session = await mint(id);

    const master = await request(getApp()).get(pathOf(session.body.manifestUrl));
    expect(master.status).toBe(200);
    expect(master.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(master.headers["cache-control"]).toBe("no-store");
    const variantUrl = master.text.split("\n").find((l) => l.includes("/720/index.m3u8"));
    expect(variantUrl).toContain("?token=");

    const variant = await request(getApp()).get(pathOf(variantUrl as string));
    expect(variant.status).toBe(200);
    expect(variant.text).not.toContain("EVS_KEY_URI");
    expect(variant.text).toContain(`https://media.example.com/media/${id}/hls/720/seg_00000.ts?X-Amz-Expires=`); // signed by the delivery driver
    const keyUrl = /URI="([^"]+)"/.exec(variant.text)?.[1] as string;

    const keyRes = await request(getApp())
      .get(pathOf(keyUrl))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(keyRes.status).toBe(200);
    expect(keyRes.headers["content-type"]).toContain("application/octet-stream");
    expect(Buffer.compare(keyRes.body as Buffer, stored.keyBytes)).toBe(0);

    const vtt = await request(getApp()).get(pathOf(session.body.thumbnailsUrl));
    expect(vtt.status).toBe(200);
    expect(vtt.text).toMatch(/media\.example\.com\/media\/.+\/thumbnails\/sprite_000\.jpg\?.*#xywh=0,0,160,90/);
  });

  it("returns 401 without a token and for a garbage token", async () => {
    const id = await createReadyVideo(key);
    for (const p of [`/v1/play/${id}/master.m3u8`, `/v1/play/${id}/720/index.m3u8`, `/v1/play/${id}/key`]) {
      expect((await request(getApp()).get(p)).status).toBe(401);
      expect((await request(getApp()).get(`${p}?token=garbage`)).status).toBe(401);
    }
  });

  it("returns 403 when a token for one video is used on another", async () => {
    const a = await createReadyVideo(key);
    const b = await createReadyVideo(key);
    const session = await mint(a);
    const token = new URL(session.body.manifestUrl).searchParams.get("token") as string;
    expect((await request(getApp()).get(`/v1/play/${b}/key?token=${encodeURIComponent(token)}`)).status).toBe(403);
  });

  it("stops serving immediately after the session is revoked", async () => {
    const id = await createReadyVideo(key);
    await contentKeyStore.generateAndStore(id);
    const session = await mint(id);
    const token = encodeURIComponent(new URL(session.body.manifestUrl).searchParams.get("token") as string);
    expect((await request(getApp()).get(`/v1/play/${id}/key?token=${token}`)).status).toBe(200);

    const revoked = await authed(key).delete(`/v1/playback-sessions/${session.body.sessionId}`);
    expect(revoked.body).toMatchObject({ active: false, revokedReason: "revoked_by_api" });
    expect((await request(getApp()).get(`/v1/play/${id}/key?token=${token}`)).status).toBe(401);
  });

  it("rejects path traversal in the rendition segment", async () => {
    const id = await createReadyVideo(key);
    const session = await mint(id);
    const token = new URL(session.body.manifestUrl).searchParams.get("token") as string;
    expect((await request(getApp()).get(`/v1/play/${id}/abc/index.m3u8?token=${encodeURIComponent(token)}`)).status).toBe(400);
  });

  it("counts playback sessions in usage", async () => {
    const id = await createReadyVideo(key);
    await mint(id);
    await mint(id, { viewerId: "b" });
    expect((await authed(key).get("/v1/usage")).body.totals.playbackSessions).toBe(2);
  });
});
