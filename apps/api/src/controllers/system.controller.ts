import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { getPool } from "@evs/core/db";
import { NotFoundError } from "@evs/core/errors";
import { registry } from "../metrics.js";

/** Liveness: the process is up and serving. Never touches dependencies. */
export const healthz = (_req: Request, res: Response): void => {
  res.json({ status: "ok" });
};

/** Readiness: dependencies answer. Load balancers stop routing here when this fails. */
export const readyz = async (_req: Request, res: Response): Promise<void> => {
  const started = Date.now();
  try {
    await getPool().query("SELECT 1");
    res.json({ status: "ready", checks: { database: { ok: true, latencyMs: Date.now() - started } } });
  } catch (err) {
    res.status(503).json({ status: "unavailable", checks: { database: { ok: false, error: (err as Error).message } } });
  }
};

export const metrics = async (_req: Request, res: Response): Promise<void> => {
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
};

// ─── OpenAPI ─────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
let spec: string | null = null;

/** OPENAPI_PATH wins; otherwise look in the usual places for source, bundle and container layouts. */
const loadSpec = (): string => {
  if (spec !== null) return spec;
  const candidates = [
    process.env.OPENAPI_PATH,
    path.resolve(process.cwd(), "docs/api/openapi.yaml"),
    path.resolve(process.cwd(), "../../docs/api/openapi.yaml"),
    path.resolve(here, "../../../../docs/api/openapi.yaml"),
    path.resolve(here, "../../../docs/api/openapi.yaml"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new NotFoundError("OpenAPI document not found (set OPENAPI_PATH)");
  spec = readFileSync(found, "utf8");
  return spec;
};

export const openapi = (_req: Request, res: Response): void => {
  res.type("application/yaml").send(loadSpec());
};

/** Pinned exactly: an unpinned CDN script is a supply-chain hole on an API's own origin. */
const SCALAR = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.52.6";

export const docs = (_req: Request, res: Response): void => {
  // This route alone loads a script, from one pinned CDN origin.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src https://cdn.jsdelivr.net",
      "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Euron Video System API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/v1/openapi.yaml"></script>
    <script src="${SCALAR}"></script>
  </body>
</html>`);
};
