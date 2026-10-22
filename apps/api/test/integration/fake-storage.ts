import { Readable } from "node:stream";

/**
 * In-memory stand-in for @evs/core/storage. Integration tests exercise the
 * real database end to end; only object storage is replaced, because the API
 * talks to it through presigning (pure crypto) and a handful of reads.
 */
export const objects = new Map<string, Buffer>(); // "<bucket>/<key>" -> bytes

const k = (bucket: string, key: string) => `${bucket}/${key}`;

export const putObject = (bucket: string, key: string, body: string | Buffer): void => {
  objects.set(k(bucket, key), Buffer.isBuffer(body) ? body : Buffer.from(body));
};

export const storage = {
  async presignUpload(key: string, maxBytes: number) {
    return {
      url: "https://uploads.example.com/",
      fields: { key, "Content-Type": "video/mp4", Policy: "fake", "X-Amz-Signature": "fake", maxBytes: String(maxBytes) },
    };
  },
  async headSize(bucket: string, key: string) {
    return objects.get(k(bucket, key))?.length ?? null;
  },
  async getText(bucket: string, key: string) {
    return objects.get(k(bucket, key))?.toString("utf8") ?? null;
  },
  async getStream(bucket: string, key: string) {
    const b = objects.get(k(bucket, key));
    return b ? { body: Readable.from(b), contentLength: b.length } : null;
  },
  async presignGet(bucket: string, key: string, ttl: number, name?: string) {
    return `https://${bucket}.example.com/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=fake${name ? `&dl=${encodeURIComponent(name)}` : ""}`;
  },
  async deletePrefix(bucket: string, prefix: string) {
    let n = 0;
    for (const key of [...objects.keys()]) {
      if (key.startsWith(k(bucket, `${prefix}/`))) {
        objects.delete(key);
        n++;
      }
    }
    return n;
  },
  async deleteObject(bucket: string, key: string) {
    objects.delete(k(bucket, key));
  },
  async sumPrefix() {
    return 0;
  },
};

export const bucketName = (b: string) => b;
