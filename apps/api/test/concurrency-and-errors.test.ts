import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { resolveConcurrencyLimit } from "../src/playback/concurrency.js";

const s = (id: string, minutesAgo: number) => ({ id, issuedAt: new Date(Date.now() - minutesAgo * 60_000) });

describe("resolveConcurrencyLimit", () => {
  it("allows freely when unlimited or under the limit", () => {
    expect(resolveConcurrencyLimit([s("a", 5), s("b", 1)], 0)).toEqual({ allow: true, revokeIds: [] });
    expect(resolveConcurrencyLimit([s("a", 5)], 2)).toEqual({ allow: true, revokeIds: [] });
  });
  it("evicts the oldest sessions to make room for the new one", () => {
    expect(resolveConcurrencyLimit([s("a", 5), s("b", 1)], 2)).toEqual({ allow: true, revokeIds: ["a"] });
    expect(resolveConcurrencyLimit([s("a", 9), s("b", 5), s("c", 1)], 1)).toEqual({ allow: true, revokeIds: ["a", "b", "c"] });
  });
});

describe("error handler", () => {
  const build = async (nodeEnv: string) => {
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    const { errorHandler } = await import("../src/http/error-handler.js");
    const { requestId } = await import("../src/http/request-id.js");
    process.env.NODE_ENV = prev;
    const app = express();
    app.use(requestId);
    app.get("/boom", () => {
      throw new Error("db password is hunter2 at /srv/app.js:42");
    });
    app.use(errorHandler);
    return app;
  };

  it("never leaks messages or stack traces in production", async () => {
    const res = await request(await build("production")).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: "internal", message: "Internal server error" });
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|stack|app\.js/);
  });

  it("echoes a well-formed inbound request id and replaces a malformed one", async () => {
    const app = await build("production");
    const ok = await request(app).get("/boom").set("X-Request-Id", "trace-12345678");
    expect(ok.headers["x-request-id"]).toBe("trace-12345678");
    const bad = await request(app).get("/boom").set("X-Request-Id", "<script>");
    expect(bad.headers["x-request-id"]).toMatch(/^req_/);
  });
});
