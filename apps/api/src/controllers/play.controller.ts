import type { Request, Response } from "express";
import { getApiConfig } from "@evs/core/config";
import { OUTPUT_FILES, RUNG_LABEL, objectKeys } from "@evs/core/constants";
import { contentKeyStore } from "@evs/core/crypto/store";
import { BadRequestError, NotFoundError } from "@evs/core/errors";
import { storage } from "@evs/core/storage";
import { getDeliveryDriver } from "../delivery/index.js";
import { param } from "../http/validate.js";
import { keyDeliveries, playlistRequests } from "../metrics.js";
import {
  collectMediaRenditionUris,
  collectSegmentUris,
  collectSpriteUris,
  isSafeRelativePath,
  rewriteMaster,
  rewriteThumbnailsVtt,
  rewriteVariant,
} from "../playback/manifest-rewrite.js";
import type { DeliveryContext } from "../services/playback.service.js";
import usageService from "../services/usage.service.js";
import videosService from "../services/videos.service.js";

/**
 * Token-gated delivery: playlists, the AES-128 key, thumbnails and posters.
 * requirePlaybackToken has already verified the token, the session, the video
 * binding and the origin; these handlers only fetch and rewrite.
 */

const ctx = (res: Response): DeliveryContext => res.locals.delivery as DeliveryContext;

const playBase = (videoId: string): string => `${getApiConfig().PUBLIC_API_BASE}/v1/play/${encodeURIComponent(videoId)}`;

const sendPlaylist = (res: Response, body: string): void => {
  res.type("application/vnd.apple.mpegurl").status(200).send(body);
};

/** Map relative paths to signed URLs in one driver call. */
const signAll = async (videoId: string, paths: string[], c: DeliveryContext): Promise<Map<string, string>> => {
  const urls = await getDeliveryDriver().urlsFor(videoId, paths, c.remainingSeconds, c.token);
  return new Map(paths.map((p, i) => [p, urls[i] as string]));
};

/** GET /v1/play/:videoId/master.m3u8 */
export const getMaster = async (req: Request, res: Response) => {
  const videoId = param(req, "videoId");
  const c = ctx(res);
  await videosService.requireReady(videoId);
  const prefix = objectKeys.outputPrefix(videoId);
  const master = await storage.getText("media", `${prefix}/${OUTPUT_FILES.hlsMaster}`);
  if (master === null) throw new NotFoundError("Manifest not found");

  const renditions = collectMediaRenditionUris(master).filter(isSafeRelativePath);
  const signed = await signAll(videoId, renditions.map((u) => `${OUTPUT_FILES.hlsDir}/${u}`), c);
  const token = encodeURIComponent(c.token);
  const base = playBase(videoId);

  const out = rewriteMaster(master, {
    // Stored variant URIs look like "720/index.m3u8".
    variantUrl: (uri) => `${base}/${uri}?token=${token}`,
    renditionUrl: (uri) => signed.get(`${OUTPUT_FILES.hlsDir}/${uri}`) ?? uri,
  });
  playlistRequests.inc({ kind: "master" });
  sendPlaylist(res, out);
};

/** GET /v1/play/:videoId/:rung/index.m3u8 */
export const getVariant = async (req: Request, res: Response) => {
  const videoId = param(req, "videoId");
  const rung = param(req, "rung");
  // Allowlist the rung so it can never traverse into another object key.
  if (!RUNG_LABEL.test(rung)) throw new BadRequestError("Invalid rendition");
  const c = ctx(res);
  await videosService.requireReady(videoId);
  const prefix = objectKeys.outputPrefix(videoId);
  const variant = await storage.getText("media", `${prefix}/${OUTPUT_FILES.hlsDir}/${rung}/index.m3u8`);
  if (variant === null) throw new NotFoundError("Rendition not found");

  const segments = collectSegmentUris(variant).filter(isSafeRelativePath);
  const paths = segments.map((s) => `${OUTPUT_FILES.hlsDir}/${rung}/${s}`);
  const signed = await signAll(videoId, paths, c);

  const out = rewriteVariant(variant, {
    keyUrl: `${playBase(videoId)}/key?token=${encodeURIComponent(c.token)}`,
    segmentUrl: (s) => signed.get(`${OUTPUT_FILES.hlsDir}/${rung}/${s}`) ?? s,
  });
  playlistRequests.inc({ kind: "variant" });
  sendPlaylist(res, out);
};

/**
 * GET /v1/play/:videoId/key: the 16 raw AES-128 key bytes.
 *
 * NOTE: HLS AES-128 is strong deterrence and access control, not DRM. A
 * viewer authorized to play the video receives the key in their browser by
 * design; what this endpoint guarantees is that ONLY authorized, unrevoked,
 * unexpired sessions receive it. See docs/architecture/security.md.
 */
export const getKey = async (req: Request, res: Response) => {
  const videoId = param(req, "videoId");
  // A deleted or cancelled video stops yielding keys immediately, even to live sessions.
  await videosService.requireReady(videoId);
  const key = await contentKeyStore.load(videoId);
  if (!key) throw new NotFoundError("No content key for this video");
  keyDeliveries.inc();
  usageService.countKeyDelivery();
  res.type("application/octet-stream").status(200).send(key.keyBytes);
};

/** GET /v1/play/:videoId/thumbnails.vtt: sprite references rewritten to signed URLs. */
export const getThumbnails = async (req: Request, res: Response) => {
  const videoId = param(req, "videoId");
  const c = ctx(res);
  await videosService.requireReady(videoId);
  const vtt = await storage.getText("media", `${objectKeys.outputPrefix(videoId)}/${OUTPUT_FILES.thumbnailsVtt}`);
  if (vtt === null) throw new NotFoundError("Thumbnails not found");
  const sprites = collectSpriteUris(vtt).filter(isSafeRelativePath);
  const signed = await signAll(videoId, sprites.map((s) => `${OUTPUT_FILES.thumbnailsDir}/${s}`), c);
  res
    .type("text/vtt")
    .status(200)
    .send(rewriteThumbnailsVtt(vtt, (s) => signed.get(`${OUTPUT_FILES.thumbnailsDir}/${s}`) ?? s));
};

/** GET /v1/play/:videoId/poster.jpg: redirect to a signed URL (or stream it in proxy mode). */
export const getPoster = async (req: Request, res: Response) => {
  const videoId = param(req, "videoId");
  const c = ctx(res);
  await videosService.requireReady(videoId);
  const driver = getDeliveryDriver();
  if (driver.name === "proxy") return streamObject(res, `${objectKeys.outputPrefix(videoId)}/${OUTPUT_FILES.poster}`);
  const [url] = await driver.urlsFor(videoId, [OUTPUT_FILES.poster], c.remainingSeconds, c.token);
  res.redirect(302, url as string);
};

const CONTENT_TYPES: Record<string, string> = {
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
  vtt: "text/vtt",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const streamObject = async (res: Response, key: string): Promise<void> => {
  const obj = await storage.getStream("media", key);
  if (!obj) throw new NotFoundError("Object not found");
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? obj.contentType ?? "application/octet-stream");
  if (obj.contentLength !== undefined) res.setHeader("Content-Length", String(obj.contentLength));
  res.status(200);
  await new Promise<void>((resolve, reject) => {
    obj.body.on("error", reject);
    res.on("close", () => {
      obj.body.destroy();
      resolve();
    });
    obj.body.pipe(res);
  });
};

/**
 * GET /v1/play/:videoId/media/*: proxy delivery (DELIVERY_DRIVER=proxy only).
 * The path is allowlisted to the video's own hls/ and thumbnails/ subtrees.
 */
export const getMediaObject = async (req: Request, res: Response) => {
  if (getDeliveryDriver().name !== "proxy") throw new NotFoundError("Proxy delivery is not enabled");
  const videoId = param(req, "videoId");
  const raw = req.params.path;
  const rel = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
  const allowed = rel.startsWith(`${OUTPUT_FILES.hlsDir}/`) || rel.startsWith(`${OUTPUT_FILES.thumbnailsDir}/`) || rel === OUTPUT_FILES.poster;
  if (!isSafeRelativePath(rel) || !allowed) throw new BadRequestError("Invalid media path");
  await streamObject(res, `${objectKeys.outputPrefix(videoId)}/${rel}`);
};
