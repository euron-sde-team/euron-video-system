import type { NextFunction, Request, Response } from "express";
import client from "prom-client";

/**
 * Prometheus metrics, exposed at GET /metrics. Labels are low-cardinality by
 * construction: the route label is the matched route PATTERN
 * ("/v1/videos/:id"), never the raw path, so per-video URLs cannot explode the
 * series count.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "evs_api_" });

export const httpDuration = new client.Histogram({
  name: "evs_api_http_request_duration_seconds",
  help: "HTTP request latency by method, route pattern and status class",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const keyDeliveries = new client.Counter({
  name: "evs_api_key_deliveries_total",
  help: "AES-128 content keys served to authorized players",
  registers: [registry],
});

export const playlistRequests = new client.Counter({
  name: "evs_api_playlist_requests_total",
  help: "HLS playlists served, by kind",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const playbackDenials = new client.Counter({
  name: "evs_api_playback_denials_total",
  help: "Delivery requests rejected, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const webhookDeliveries = new client.Counter({
  name: "evs_api_webhook_deliveries_total",
  help: "Webhook delivery attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : "unmatched";
    end({ method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` });
  });
  next();
};
