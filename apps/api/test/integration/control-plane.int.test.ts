import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@evs/core/db";
import { resetDatabase } from "../../../../tests/integration/db.js";
import { verifySignature } from "../../src/webhooks/signature.js";
import { WebhookDispatcher } from "../../src/webhooks/dispatcher.js";
import { authed, clearObjects, createKey } from "./helpers.js";

vi.mock("@evs/core/storage", () => import("./fake-storage.js"));

let key: string;
beforeEach(async () => {
  await resetDatabase();
  clearObjects();
  key = await createKey(["*"]);
});

describe("playback policies", () => {
  it("CRUD with validation, and the default cannot be deleted", async () => {
    const list = await authed(key).get("/v1/playback-policies");
    expect(list.body.data).toHaveLength(1);
    const dflt = list.body.data[0];
    expect(dflt).toMatchObject({ name: "default", isDefault: true });
    expect((await authed(key).delete(`/v1/playback-policies/${dflt.id}`)).status).toBe(409);

    const bad = await authed(key).post("/v1/playback-policies").send({ name: "x", tokenTtlSeconds: 900, maxTokenTtlSeconds: 60 });
    expect(bad.status).toBe(400);

    const created = await authed(key)
      .post("/v1/playback-policies")
      .send({ name: "strict", tokenTtlSeconds: 60, allowedOrigins: ["https://App.Example.com/path"], maxConcurrentSessions: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ allowedOrigins: ["https://app.example.com"], isDefault: false });
    expect((await authed(key).post("/v1/playback-policies").send({ name: "strict" })).status).toBe(409);

    const patched = await authed(key).patch(`/v1/playback-policies/${created.body.id}`).send({ allowDownload: true });
    expect(patched.body.allowDownload).toBe(true);
    expect((await authed(key).get(`/v1/playback-policies/${created.body.id}`)).body.allowDownload).toBe(true);
    expect((await authed(key).delete(`/v1/playback-policies/${created.body.id}`)).status).toBe(204);
    expect((await authed(key).get(`/v1/playback-policies/${created.body.id}`)).status).toBe(404);
  });

  it("switches the default atomically", async () => {
    const seeded = (await authed(key).get("/v1/playback-policies")).body.data[0];
    const created = await authed(key).post("/v1/playback-policies").send({ name: "new-default", isDefault: true });
    expect(created.body.isDefault).toBe(true);
    const defaults = (await authed(key).get("/v1/playback-policies")).body.data.filter((p: { isDefault: boolean }) => p.isDefault);
    expect(defaults.map((p: { name: string }) => p.name)).toEqual(["new-default"]);
    expect((await authed(key).patch(`/v1/playback-policies/${created.body.id}`).send({ isDefault: false })).status).toBe(400);
    // Hand the default back so the shared reset (which keeps only the default) preserves the seed.
    expect((await authed(key).patch(`/v1/playback-policies/${seeded.id}`).send({ isDefault: true })).body.isDefault).toBe(true);
  });
});

describe("webhooks", () => {
  let server: Server;
  let received: Array<{ headers: IncomingMessage["headers"]; body: string }>;
  let respondWith: number[];

  beforeEach(async () => {
    received = [];
    respondWith = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respondWith.shift() ?? 200;
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;

  it("create returns the signing secret once; unknown events are rejected", async () => {
    expect((await authed(key).post("/v1/webhooks").send({ url: url(), events: ["video.nope"] })).status).toBe(400);
    const created = await authed(key).post("/v1/webhooks").send({ url: url(), events: ["video.ready"], description: "ci" });
    expect(created.status).toBe(201);
    expect(created.body.signingSecret).toMatch(/^whsec_/);
    const fetched = await authed(key).get(`/v1/webhooks/${created.body.id}`);
    expect(fetched.body).not.toHaveProperty("signingSecret");
    const row = await getDb().selectFrom("webhook_endpoints").select(["secret_ciphertext"]).executeTakeFirstOrThrow();
    expect(row.secret_ciphertext).not.toContain(created.body.signingSecret);
  });

  it("dispatcher delivers a signed test event, retries a 500, and records attempts", async () => {
    const created = await authed(key).post("/v1/webhooks").send({ url: url(), events: ["*"] });
    const secret = created.body.signingSecret as string;
    const test = await authed(key).post(`/v1/webhooks/${created.body.id}/test`);
    expect(test.status).toBe(202);

    const dispatcher = new WebhookDispatcher();
    respondWith = [500];
    expect(await dispatcher.tick()).toBe(1);
    let deliveries = (await authed(key).get(`/v1/webhooks/${created.body.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: 500 });
    expect(Date.parse(deliveries[0].nextAttemptAt)).toBeGreaterThan(Date.now());

    // Not due yet: nothing is claimed.
    expect(await dispatcher.tick()).toBe(0);
    await sql`UPDATE webhook_deliveries SET next_attempt_at = now()`.execute(getDb());
    expect(await dispatcher.tick()).toBe(1);

    deliveries = (await authed(key).get(`/v1/webhooks/${created.body.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ status: "delivered", attempts: 2, lastStatusCode: 200 });

    expect(received).toHaveLength(2);
    const last = received[1]!;
    expect(last.headers["evs-event-type"]).toBe("webhook.test");
    expect(last.headers["evs-event-id"]).toBe(received[0]!.headers["evs-event-id"]); // stable across retries
    const sig = String(last.headers["evs-signature"]);
    expect(verifySignature(secret, last.body, sig, Math.floor(Date.now() / 1000))).toBe(true);
    expect(verifySignature("wrong", last.body, sig, Math.floor(Date.now() / 1000))).toBe(false);
    expect(JSON.parse(last.body)).toMatchObject({ type: "webhook.test", data: { endpointId: created.body.id } });
  });

  it("redeliver re-arms a delivered event; disabled endpoints fail deliveries", async () => {
    const created = await authed(key).post("/v1/webhooks").send({ url: url(), events: ["*"] });
    const test = await authed(key).post(`/v1/webhooks/${created.body.id}/test`);
    const dispatcher = new WebhookDispatcher();
    await dispatcher.tick();
    const again = await authed(key).post(`/v1/webhook-deliveries/${test.body.id}/redeliver`);
    expect(again.body).toMatchObject({ status: "pending", attempts: 0 });
    await dispatcher.tick();
    expect(received).toHaveLength(2);

    await authed(key).patch(`/v1/webhooks/${created.body.id}`).send({ enabled: false });
    await authed(key).post(`/v1/webhooks/${created.body.id}/test`);
    await dispatcher.tick();
    expect(received).toHaveLength(2);
    const deliveries = (await authed(key).get(`/v1/webhooks/${created.body.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ lastError: "endpoint disabled" });

    expect((await authed(key).delete(`/v1/webhooks/${created.body.id}`)).status).toBe(204);
    expect((await authed(key).get("/v1/webhooks")).body.data).toHaveLength(0);
  });
});

describe("audit trail and usage", () => {
  it("records every mutation with actor and request id, newest first, cursor-paginated", async () => {
    const created = await authed(key).post("/v1/videos").send({ title: "Audited", filename: "a.mp4" }).set("X-Request-Id", "audit-trace-0001");
    const id = created.body.video.id;
    await authed(key).patch(`/v1/videos/${id}`).send({ title: "Audited 2" });
    await authed(key).post("/v1/playback-policies").send({ name: "p1" });

    const all = await authed(key).get("/v1/audit-events?limit=2");
    expect(all.status).toBe(200);
    expect(all.body.data.map((e: { action: string }) => e.action)).toEqual(["playback_policy.create", "video.update"]);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await authed(key).get(`/v1/audit-events?limit=2&cursor=${all.body.nextCursor}`);
    expect(next.body.data.map((e: { action: string }) => e.action)).toEqual(["video.create"]);
    expect(next.body.data[0]).toMatchObject({ requestId: "audit-trace-0001", resource: { type: "video", id }, actor: { type: "api_key" } });

    const filtered = await authed(key).get(`/v1/audit-events?resourceId=${id}`);
    expect(filtered.body.data).toHaveLength(2);
  });

  it("the audit log is append-only at the database level", async () => {
    await authed(key).post("/v1/playback-policies").send({ name: "p1" });
    await expect(sql`UPDATE audit_events SET action = 'tampered'`.execute(getDb())).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events`.execute(getDb())).rejects.toThrow(/append-only/);
  });

  it("usage validates its range and aggregates days", async () => {
    expect((await authed(key).get("/v1/usage?from=2026-02-01&to=2026-01-01")).status).toBe(400);
    expect((await authed(key).get("/v1/usage?from=bad")).status).toBe(400);
    await sql`INSERT INTO usage_daily (day, videos_created, playback_sessions) VALUES ('2026-01-01', 3, 5), ('2026-01-02', 1, 2)`.execute(getDb());
    const res = await authed(key).get("/v1/usage?from=2026-01-01&to=2026-01-31");
    expect(res.body.days.map((d: { day: string }) => d.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(res.body.totals).toMatchObject({ videosCreated: 4, playbackSessions: 7 });
  });
});

describe("system endpoints", () => {
  it("serve health, readiness, metrics, the spec and the docs page without auth", async () => {
    const { default: request } = await import("supertest");
    const { getApp } = await import("./helpers.js");
    const app = getApp();
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.ok).toBe(true);
    await request(app).get("/v1/me"); // generate at least one sample
    const metrics = await request(app).get("/metrics");
    expect(metrics.text).toContain("evs_api_http_request_duration_seconds");
    const spec = await request(app).get("/v1/openapi.yaml");
    expect(spec.text).toMatch(/^openapi: 3\.1\.0/);
    const docs = await request(app).get("/docs");
    expect(docs.headers["content-security-policy"]).toContain("script-src https://cdn.jsdelivr.net");
    expect(docs.text).toContain("@scalar/api-reference@1.52.6");
  });
});
