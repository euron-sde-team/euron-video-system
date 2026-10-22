import express, { type Express } from "express";
import helmet from "helmet";
import { getApiConfig } from "@evs/core/config";
import * as system from "./controllers/system.controller.js";
import { asyncHandler } from "./http/async-handler.js";
import { errorHandler, notFound } from "./http/error-handler.js";
import { requestId } from "./http/request-id.js";
import { metricsMiddleware } from "./metrics.js";
import { createV1Router } from "./routes/v1.route.js";

/**
 * Express application factory. Kept free of side effects (no listen, no
 * timers) so tests can mount it with supertest.
 */
export const createApp = (): Express => {
  const cfg = getApiConfig();
  const app = express();

  app.disable("x-powered-by");
  // Trust exactly N proxy hops (the ALB): req.ip is the real client, and a
  // client-supplied X-Forwarded-For cannot spoof its way past rate limits.
  app.set("trust proxy", cfg.TRUST_PROXY_HOPS);

  app.use(requestId);
  app.use(metricsMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      // Playlists, keys and posters are fetched cross-origin by embedded players.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", system.healthz);
  app.get("/readyz", asyncHandler(system.readyz));
  app.get("/metrics", asyncHandler(system.metrics));
  app.get("/v1/openapi.yaml", system.openapi);
  app.get("/docs", system.docs);

  app.use("/v1", createV1Router());

  app.use(asyncHandler(notFound));
  app.use(errorHandler);
  return app;
};
