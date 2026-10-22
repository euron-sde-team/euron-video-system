import { sql } from "kysely";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@evs/core/db";
import { resetDatabase } from "../../../../tests/integration/db.js";
import apiKeysService from "../../src/services/api-keys.service.js";
import { authed, createKey, getApp } from "./helpers.js";

vi.mock("@evs/core/storage", () => import("./fake-storage.js"));

beforeEach(async () => {
  await resetDatabase();
  apiKeysService.clearCache();
});

describe("API key authentication", () => {
  it("rejects a missing, malformed or unknown key with 401 and a request id", async () => {
    const none = await request(getApp()).get("/v1/me");
    expect(none.status).toBe(401);
    expect(none.body.error).toMatchObject({ code: "unauthorized" });
    expect(none.body.error.requestId).toBe(none.headers["x-request-id"]);

    expect((await authed("not-a-key").get("/v1/me")).status).toBe(401);
    expect((await authed(`evs_abcdefgh_${"x".repeat(43)}`).get("/v1/me")).status).toBe(401);
  });

  it("accepts a valid key and reports its identity", async () => {
    const key = await createKey(["videos:read"], "reader");
    const res = await authed(key).get("/v1/me");
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatchObject({ name: "reader", scopes: ["videos:read"], prefix: key.slice(4, 12) });
  });

  it("rejects a revoked key and an expired key", async () => {
    const admin = await createKey(["*"], "admin");
    const victim = await createKey(["videos:read"], "victim");
    const victimId = (await authed(victim).get("/v1/me")).body.apiKey.id;
    expect((await authed(admin).delete(`/v1/api-keys/${victimId}`)).status).toBe(204);
    expect((await authed(victim).get("/v1/me")).status).toBe(401);

    const expiring = await createKey(["videos:read"], "expiring");
    await sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE name = 'expiring'`.execute(getDb());
    apiKeysService.clearCache();
    expect((await authed(expiring).get("/v1/me")).status).toBe(401);
  });

  it("denies a key lacking the route's scope with 403", async () => {
    const reader = await createKey(["videos:read"]);
    const res = await authed(reader).post("/v1/videos").send({ title: "t", filename: "a.mp4" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "forbidden", details: { required: ["videos:write"] } });
    expect((await authed(reader).get("/v1/audit-events")).status).toBe(403);
  });
});

describe("API key management", () => {
  it("creates (secret shown once), lists and revokes keys", async () => {
    const admin = await createKey(["*"], "admin");
    const created = await authed(admin).post("/v1/api-keys").send({ name: "ci", scopes: ["videos:read", "videos:write"] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^evs_[a-z0-9]{8}_/);
    expect(created.body.apiKey).not.toHaveProperty("keyHash");

    const list = await authed(admin).get("/v1/api-keys");
    expect(list.body.data.map((k: { name: string }) => k.name).sort()).toEqual(["admin", "ci"]);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);

    expect((await authed(created.body.secret).get("/v1/me")).status).toBe(200);
    expect((await authed(admin).delete(`/v1/api-keys/${created.body.apiKey.id}`)).status).toBe(204);
    expect((await authed(admin).get("/v1/api-keys")).body.data).toHaveLength(1);
    expect((await authed(admin).get("/v1/api-keys?includeRevoked=true")).body.data).toHaveLength(2);
  });

  it("refuses to let a key revoke itself", async () => {
    const admin = await createKey(["*"], "admin");
    const me = (await authed(admin).get("/v1/me")).body.apiKey.id;
    const res = await authed(admin).delete(`/v1/api-keys/${me}`);
    expect(res.status).toBe(409);
  });

  it("refuses to mint a key with scopes the caller does not hold (no privilege escalation)", async () => {
    const manager = await createKey(["keys:manage", "videos:read"], "manager");
    expect((await authed(manager).post("/v1/api-keys").send({ name: "ok", scopes: ["videos:read"] })).status).toBe(201);
    const escalate = await authed(manager).post("/v1/api-keys").send({ name: "bad", scopes: ["videos:write"] });
    expect(escalate.status).toBe(403);
    const wildcard = await authed(manager).post("/v1/api-keys").send({ name: "bad2", scopes: ["*"] });
    expect(wildcard.status).toBe(403);
  });

  it("validates input with field-level details", async () => {
    const admin = await createKey();
    const res = await authed(admin).post("/v1/api-keys").send({ name: "", scopes: ["nope"], extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.details.issues.length).toBeGreaterThan(0);
  });
});
