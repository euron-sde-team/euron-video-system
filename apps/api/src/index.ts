// TZ must be UTC before any other module loads: pg serializes Dates with local
// getters, so a non-UTC process would write local time and read it back as UTC.
// (Static imports are hoisted, so the container/compose env also sets TZ=UTC.)
process.env.TZ = "UTC";
process.env.EVS_SERVICE ??= "api";

import cluster from "node:cluster";
import os from "node:os";
import type { Server } from "node:http";
import { ConfigError, getApiConfig, getCoreConfig } from "@evs/core/config";
import { closeDatabase, waitForDatabase } from "@evs/core/db";
import logger from "@evs/core/logger";
import { createApp } from "./app.js";
import usageService from "./services/usage.service.js";
import dispatcher from "./webhooks/dispatcher.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

const loadConfig = () => {
  try {
    return { core: getCoreConfig(), api: getApiConfig() };
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
};

const { core, api } = loadConfig();
const workers = api.CLUSTER_WORKERS === 0 ? os.availableParallelism() : api.CLUSTER_WORKERS;

if (cluster.isPrimary && workers > 1) {
  // ─── Primary: supervise N workers, each with its own DB pool ─────────────
  logger.info(`primary ${process.pid} starting ${workers} workers (${core.NODE_ENV}, cloud=${core.EVS_CLOUD})`);
  for (let i = 0; i < workers; i++) cluster.fork();

  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    logger.warn(`worker ${worker.process.pid} exited (${signal ?? code}); forking a replacement`);
    cluster.fork();
  });

  const shutdown = (sig: string) => {
    shuttingDown = true;
    logger.info(`${sig}: stopping workers`);
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill("SIGTERM");
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} else {
  // ─── Worker (or single-process mode) ─────────────────────────────────────
  void (async () => {
    process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", { reason: String(reason) }));

    await waitForDatabase();
    usageService.start();
    if (api.WEBHOOK_DISPATCH_ENABLED) dispatcher.start();

    const server: Server = createApp().listen(api.PORT, () => {
      logger.info(`API listening on :${api.PORT} (pid ${process.pid}, delivery=${api.DELIVERY_DRIVER})`);
    });
    // Must exceed the ALB idle timeout (60s) or the LB reuses sockets we closed.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    const shutdown = (sig: string) => {
      logger.info(`${sig}: draining`);
      server.close(async () => {
        await dispatcher.stop();
        await usageService.stop();
        await closeDatabase();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })();
}
