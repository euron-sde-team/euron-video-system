import type { Request, Response } from "express";
import { z } from "zod";
import { BadRequestError } from "@evs/core/errors";
import { EVENT_TYPES } from "@evs/core/queue";
import { iso, page, paginationQuery } from "../http/pagination.js";
import { body, param, query } from "../http/validate.js";
import { actorOf } from "../services/actor.js";
import { SCOPES, WILDCARD_SCOPE } from "../services/api-key-format.js";
import apiKeysService from "../services/api-keys.service.js";
import auditService from "../services/audit.service.js";
import playbackService from "../services/playback.service.js";
import policiesService from "../services/policies.service.js";
import usageService from "../services/usage.service.js";
import webhooksService from "../services/webhooks.service.js";

// ─── Me ──────────────────────────────────────────────────────────────────────

export const getMe = async (req: Request, res: Response) => {
  const a = req.auth!;
  res.json({
    apiKey: { id: a.apiKeyId, name: a.name, prefix: a.prefix, scopes: a.scopes, createdAt: iso(a.createdAt), expiresAt: iso(a.expiresAt) },
  });
};

// ─── API keys ────────────────────────────────────────────────────────────────

const scopeSchema = z.enum([...SCOPES, WILDCARD_SCOPE] as [string, ...string[]]);
const createKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(scopeSchema).min(1),
    expiresAt: z.string().datetime().nullish(),
  })
  .strict();

export const listApiKeys = async (req: Request, res: Response) => {
  const { includeRevoked } = query(req, z.object({ includeRevoked: z.enum(["true", "false"]).optional() }));
  res.json({ data: await apiKeysService.list(includeRevoked === "true") });
};

export const createApiKey = async (req: Request, res: Response) => {
  const input = body(req, createKeySchema);
  const result = await apiKeysService.create(req.auth!, input);
  await auditService.record(actorOf(req), "api_key.create", { type: "api_key", id: result.apiKey.id }, {
    name: input.name,
    scopes: input.scopes,
  });
  res.status(201).json(result);
};

export const revokeApiKey = async (req: Request, res: Response) => {
  const id = param(req, "id");
  await apiKeysService.revoke(req.auth!, id);
  await auditService.record(actorOf(req), "api_key.revoke", { type: "api_key", id });
  res.status(204).end();
};

// ─── Playback policies ───────────────────────────────────────────────────────

const origin = z
  .string()
  .url()
  .transform((u) => new URL(u).origin.toLowerCase());
const policyFields = {
  name: z.string().trim().min(1).max(100),
  tokenTtlSeconds: z.number().int().min(10).max(86_400),
  maxTokenTtlSeconds: z.number().int().min(10).max(86_400),
  allowedOrigins: z.array(origin).max(100),
  maxConcurrentSessions: z.number().int().min(0).max(1000),
  watermarkRequired: z.boolean(),
  allowDownload: z.boolean(),
  isDefault: z.boolean(),
};
const createPolicySchema = z
  .object({
    ...policyFields,
    tokenTtlSeconds: policyFields.tokenTtlSeconds.default(300),
    maxTokenTtlSeconds: policyFields.maxTokenTtlSeconds.default(3600),
    allowedOrigins: policyFields.allowedOrigins.default([]),
    maxConcurrentSessions: policyFields.maxConcurrentSessions.default(0),
    watermarkRequired: policyFields.watermarkRequired.default(true),
    allowDownload: policyFields.allowDownload.default(false),
    isDefault: policyFields.isDefault.optional(),
  })
  .strict();
const updatePolicySchema = z.object(policyFields).partial().strict();

export const listPolicies = async (_req: Request, res: Response) => {
  res.json({ data: await policiesService.list() });
};

export const getPolicy = async (req: Request, res: Response) => {
  res.json(await policiesService.get(param(req, "id")));
};

export const createPolicy = async (req: Request, res: Response) => {
  const input = body(req, createPolicySchema);
  const policy = await policiesService.create(input);
  await auditService.record(actorOf(req), "playback_policy.create", { type: "playback_policy", id: policy.id }, input);
  res.status(201).json(policy);
};

export const updatePolicy = async (req: Request, res: Response) => {
  const patch = body(req, updatePolicySchema);
  const id = param(req, "id");
  const policy = await policiesService.update(id, patch);
  await auditService.record(actorOf(req), "playback_policy.update", { type: "playback_policy", id }, patch);
  res.json(policy);
};

export const deletePolicy = async (req: Request, res: Response) => {
  const id = param(req, "id");
  await policiesService.delete(id);
  await auditService.record(actorOf(req), "playback_policy.delete", { type: "playback_policy", id });
  res.status(204).end();
};

// ─── Playback sessions ───────────────────────────────────────────────────────

const listSessionsSchema = z.object({
  videoId: z.string().max(64).optional(),
  viewerId: z.string().max(200).optional(),
  active: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  ...paginationQuery,
});

export const listSessions = async (req: Request, res: Response) => {
  const q = query(req, listSessionsSchema);
  const { rows, total } = await playbackService.list(q);
  res.json(page(rows, q.page, q.limit, total));
};

export const revokeSession = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const session = await playbackService.revoke(id);
  await auditService.record(actorOf(req), "playback_session.revoke", { type: "playback_session", id }, {
    videoId: session.videoId,
    viewerId: session.viewerId,
  });
  res.json(session);
};

// ─── Webhooks ────────────────────────────────────────────────────────────────

const eventSchema = z.enum([...EVENT_TYPES, "*"] as [string, ...string[]]);
const createWebhookSchema = z
  .object({
    url: z.string().url().max(2000),
    events: z.array(eventSchema).min(1),
    description: z.string().trim().max(500).nullish(),
  })
  .strict();
const updateWebhookSchema = z
  .object({
    url: z.string().url().max(2000),
    events: z.array(eventSchema).min(1),
    description: z.string().trim().max(500).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export const listWebhooks = async (_req: Request, res: Response) => {
  res.json({ data: await webhooksService.list() });
};

export const getWebhook = async (req: Request, res: Response) => {
  res.json(await webhooksService.get(param(req, "id")));
};

export const createWebhook = async (req: Request, res: Response) => {
  const input = body(req, createWebhookSchema);
  const webhook = await webhooksService.create(input);
  await auditService.record(actorOf(req), "webhook.create", { type: "webhook", id: webhook.id }, {
    url: input.url,
    events: input.events,
  });
  res.status(201).json(webhook);
};

export const updateWebhook = async (req: Request, res: Response) => {
  const patch = body(req, updateWebhookSchema);
  const id = param(req, "id");
  const webhook = await webhooksService.update(id, patch);
  await auditService.record(actorOf(req), "webhook.update", { type: "webhook", id }, patch);
  res.json(webhook);
};

export const deleteWebhook = async (req: Request, res: Response) => {
  const id = param(req, "id");
  await webhooksService.delete(id);
  await auditService.record(actorOf(req), "webhook.delete", { type: "webhook", id });
  res.status(204).end();
};

export const testWebhook = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const delivery = await webhooksService.test(id);
  await auditService.record(actorOf(req), "webhook.test", { type: "webhook", id });
  res.status(202).json(delivery);
};

export const listDeliveries = async (req: Request, res: Response) => {
  const q = query(req, z.object(paginationQuery));
  const { rows, total } = await webhooksService.deliveries(param(req, "id"), q.page, q.limit);
  res.json(page(rows, q.page, q.limit, total));
};

export const redeliver = async (req: Request, res: Response) => {
  const id = param(req, "id");
  const delivery = await webhooksService.redeliver(id);
  await auditService.record(actorOf(req), "webhook_delivery.redeliver", { type: "webhook_delivery", id });
  res.status(202).json(delivery);
};

// ─── Audit + usage ───────────────────────────────────────────────────────────

const auditQuery = z.object({
  action: z.string().max(100).optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(100).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listAuditEvents = async (req: Request, res: Response) => {
  res.json(await auditService.list(query(req, auditQuery)));
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const getUsage = async (req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const q = query(req, z.object({ from: day.default(monthAgo), to: day.default(today) }));
  if (q.from > q.to) throw new BadRequestError("from must be on or before to");
  if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 366) throw new BadRequestError("range cannot exceed 366 days");
  res.json({ from: q.from, to: q.to, ...(await usageService.range(q.from, q.to)) });
};
