import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import logger from "@evs/core/logger";
import { storage, type Bucket } from "@evs/core/storage";
import { OwnershipLostError } from "./encoding/exec.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an idempotent PUT with exponential backoff + jitter. `fn` is invoked
 * fresh on every attempt so the caller re-creates the read stream (a consumed
 * stream cannot be replayed, which is why the SDK's own retry cannot cover
 * stream-body PUTs). A lost-claim abort (OwnershipLostError / aborted signal) is
 * NEVER retried: it surfaces immediately so a reaped or cancelled video stops
 * shipping bytes.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal,
  attempts = 5,
  baseMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new OwnershipLostError(label);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OwnershipLostError || signal?.aborted) throw err;
      lastErr = err;
      if (attempt === attempts) break;
      const backoff = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      logger.warn(`[upload] ${label} attempt ${attempt}/${attempts} failed: ${(err as Error).message}; retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

export const contentTypeFor = (file: string): string => {
  if (file.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (file.endsWith(".ts")) return "video/mp2t";
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".vtt")) return "text/vtt";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

/**
 * Playlists get a short TTL (so a captions re-publish propagates within
 * minutes); everything else is immutable for the life of the video. Objects are
 * private either way: these headers govern the CDN and the browser cache once a
 * request has been authorized.
 */
export const cacheControlFor = (file: string): string =>
  file.endsWith(".m3u8") ? "private, max-age=300" : "private, max-age=31536000, immutable";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    // Defensive: never ship a raw AES key file even if one lands under the tree.
    // (The key file lives in the temp renditions dir, not here, but this
    // guarantees a content key can never reach object storage.)
    else if (!entry.name.endsWith(".key") && !entry.name.endsWith(".keyinfo")) out.push(full);
  }
  return out;
}

/** Bounded-concurrency map (no extra dependency). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
}

export interface UploadOutputResult {
  fileCount: number;
  /** Total size of the uploaded tree. */
  bytes: number;
}

/**
 * Upload a packaged output tree to the media bucket under `{prefix}/...`, eight
 * files at a time. Returns the byte total (summed here) so the caller persists
 * the video's storage footprint without a later LIST.
 */
export const uploadOutputTree = async (
  localDir: string,
  prefix: string,
  signal?: AbortSignal
): Promise<UploadOutputResult> => {
  const files = await walk(localDir);
  let bytes = 0;

  await mapPool(files, 8, async (filePath) => {
    // Per-file abort check: a claim lost mid-upload stops within one file (a few
    // MB segment) instead of shipping the rest of a multi-GB tree.
    if (signal?.aborted) throw new OwnershipLostError("upload-output");
    const rel = path.relative(localDir, filePath).split(path.sep).join("/");
    const size = await withRetry(
      () =>
        storage.uploadFile("media", `${prefix}/${rel}`, filePath, contentTypeFor(filePath), cacheControlFor(filePath), signal),
      `put ${rel}`,
      signal
    );
    bytes += size;
  });

  logger.info(`[upload] ${files.length} files (${bytes} bytes) -> media/${prefix}/`);
  return { fileCount: files.length, bytes };
};

/**
 * Upload one file (the processed MP4) to a private bucket. No public cache
 * headers: it is the full unencrypted video, served only via short-lived
 * presigned GETs.
 */
export const uploadPrivateFile = async (
  bucket: Bucket,
  key: string,
  filePath: string,
  contentType: string,
  signal?: AbortSignal
): Promise<number> => {
  const size = (await stat(filePath)).size;
  await withRetry(() => storage.uploadFile(bucket, key, filePath, contentType, "private, no-store", signal), `put ${key}`, signal);
  logger.info(`[upload] ${size} bytes -> ${bucket}/${key}`);
  return size;
};
