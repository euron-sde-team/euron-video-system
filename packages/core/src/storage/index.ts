import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createPresignedPost, type PresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCoreConfig } from "../config/index.js";

/**
 * S3-compatible object storage. One implementation covers AWS S3, the local
 * emulator, MinIO and Cloudflare R2: the differences are configuration only
 * (endpoint, path-style addressing, credentials).
 *
 * Two clients exist on purpose. `internal` is what this process uses to talk to
 * storage. `presign` signs URLs a BROWSER will use. They differ in local
 * Docker setups where the API reaches the emulator as http://floci:4566 but a
 * browser must use http://localhost:4566; SigV4 signs the host, so a URL
 * presigned against the internal hostname would fail in the browser.
 */

export type Bucket = "uploads" | "media" | "downloads";

let clients: { internal: S3Client; presign: S3Client } | null = null;

const getClients = (): { internal: S3Client; presign: S3Client } => {
  if (clients) return clients;
  const cfg = getCoreConfig();
  // Credentials come from the default provider chain (env, profile, ECS task
  // role, EC2 instance role). No static keys in config, ever.
  const base: S3ClientConfig = {
    region: cfg.AWS_REGION,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    // Adaptive retry backs off under throttling (S3 503 SlowDown) instead of failing.
    retryMode: "adaptive",
    maxAttempts: 6,
  };
  const internal = new S3Client(base);
  const presign = cfg.S3_PUBLIC_ENDPOINT
    ? new S3Client({ ...base, endpoint: cfg.S3_PUBLIC_ENDPOINT, forcePathStyle: true })
    : internal;
  clients = { internal, presign };
  return clients;
};

export const bucketName = (bucket: Bucket): string => {
  const cfg = getCoreConfig();
  return { uploads: cfg.UPLOADS_BUCKET, media: cfg.MEDIA_BUCKET, downloads: cfg.DOWNLOADS_BUCKET }[bucket];
};

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
};

export const storage = {
  /**
   * Browser upload: a presigned POST, so S3 itself enforces the size range and
   * a video/* content type at upload time. The API never proxies upload bytes.
   */
  async presignUpload(key: string, maxBytes: number, expiresSeconds = 3600): Promise<PresignedPost> {
    return createPresignedPost(getClients().presign, {
      Bucket: bucketName("uploads"),
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["starts-with", "$Content-Type", "video/"],
      ],
      Expires: expiresSeconds,
    });
  },

  /** Verified byte size, or null when absent. /complete never trusts the client's "done". */
  async headSize(bucket: Bucket, key: string): Promise<number | null> {
    try {
      const head = await getClients().internal.send(new HeadObjectCommand({ Bucket: bucketName(bucket), Key: key }));
      return head.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** Small text object (a playlist, a VTT). Null when absent. */
  async getText(bucket: Bucket, key: string): Promise<string | null> {
    try {
      const out = await getClients().internal.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
      return out.Body ? await out.Body.transformToString() : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** Stream an object (proxy delivery). Null when absent. */
  async getStream(
    bucket: Bucket,
    key: string
  ): Promise<{ body: Readable; contentType?: string; contentLength?: number } | null> {
    try {
      const out = await getClients().internal.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
      if (!out.Body) return null;
      return { body: out.Body as Readable, contentType: out.ContentType, contentLength: out.ContentLength };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** Short-lived presigned GET, optionally as an attachment with a friendly filename. */
  async presignGet(bucket: Bucket, key: string, ttlSeconds: number, downloadName?: string): Promise<string> {
    return getSignedUrl(
      getClients().presign,
      new GetObjectCommand({
        Bucket: bucketName(bucket),
        Key: key,
        ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
      }),
      { expiresIn: ttlSeconds }
    );
  },

  /** Worker: stream an object to a local file. Abortable mid-transfer. */
  async downloadToFile(bucket: Bucket, key: string, destPath: string, signal?: AbortSignal): Promise<void> {
    const out = await getClients().internal.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }), {
      abortSignal: signal,
    });
    if (!out.Body) throw new Error(`object ${key} has no body`);
    await pipeline(out.Body as Readable, createWriteStream(destPath), { signal });
  },

  /** Worker: upload one local file. Returns its size. */
  async uploadFile(
    bucket: Bucket,
    key: string,
    filePath: string,
    contentType: string,
    cacheControl?: string,
    signal?: AbortSignal
  ): Promise<number> {
    const size = (await stat(filePath)).size;
    await getClients().internal.send(
      new PutObjectCommand({
        Bucket: bucketName(bucket),
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      }),
      { abortSignal: signal }
    );
    return size;
  },

  /** Total bytes under a prefix (paginated LIST). */
  async sumPrefix(bucket: Bucket, prefix: string): Promise<number> {
    const normalized = `${prefix.replace(/\/+$/, "")}/`;
    let total = 0;
    let token: string | undefined;
    do {
      const out = await getClients().internal.send(
        new ListObjectsV2Command({ Bucket: bucketName(bucket), Prefix: normalized, ContinuationToken: token })
      );
      for (const obj of out.Contents ?? []) total += obj.Size ?? 0;
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return total;
  },

  /** Delete every object under a prefix in batches of 1000. Returns objects deleted. */
  async deletePrefix(bucket: Bucket, prefix: string): Promise<number> {
    const normalized = `${prefix.replace(/\/+$/, "")}/`;
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await getClients().internal.send(
        new ListObjectsV2Command({ Bucket: bucketName(bucket), Prefix: normalized, ContinuationToken: token })
      );
      const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) {
        await getClients().internal.send(
          new DeleteObjectsCommand({ Bucket: bucketName(bucket), Delete: { Objects: objects, Quiet: true } })
        );
        deleted += objects.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  },

  async deleteObject(bucket: Bucket, key: string): Promise<void> {
    await getClients().internal.send(
      new DeleteObjectsCommand({ Bucket: bucketName(bucket), Delete: { Objects: [{ Key: key }], Quiet: true } })
    );
  },
};
