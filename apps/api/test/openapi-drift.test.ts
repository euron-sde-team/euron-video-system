import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createV1Router } from "../src/routes/v1.route.js";

/**
 * Drift guard: every route the router actually serves must be documented in
 * docs/api/openapi.yaml with the same method, and the spec must not document
 * routes that do not exist. Adding an endpoint without documenting it fails CI.
 */
interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

const collect = (stack: Layer[], prefix: string, out: Set<string>): void => {
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.add(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
    } else if (layer.handle?.stack) {
      // The only nested router with token-gated routes is mounted at /play/:videoId.
      const nested = layer.handle.stack;
      const isPlay = nested.some((l) => l.route?.path === "/key");
      collect(nested, isPlay ? `${prefix}/play/:videoId` : prefix, out);
    }
  }
};

const toOpenApi = (p: string): string => p.replace(/\*(\w+)/g, "{$1}").replace(/:(\w+)/g, "{$1}");

describe("OpenAPI spec", () => {
  it("documents exactly the routes the /v1 router serves", () => {
    const served = new Set<string>();
    collect((createV1Router() as unknown as { stack: Layer[] }).stack, "/v1", served);
    const servedNormalized = new Set([...served].map((r) => {
      const [m, p] = r.split(" ");
      return `${m} ${toOpenApi(p as string)}`;
    }));

    const here = path.dirname(fileURLToPath(import.meta.url));
    const spec = parse(readFileSync(path.resolve(here, "../../../docs/api/openapi.yaml"), "utf8")) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(spec.paths)) {
      if (!p.startsWith("/v1/") || p === "/v1/openapi.yaml") continue;
      for (const m of Object.keys(ops)) if (["get", "post", "patch", "delete", "put"].includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
    }

    expect([...servedNormalized].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !servedNormalized.has(r))).toEqual([]);
    expect(servedNormalized.size).toBeGreaterThan(35);
  });
});
