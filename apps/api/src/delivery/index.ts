import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { getApiConfig } from "@evs/core/config";
import { objectKeys } from "@evs/core/constants";
import { storage } from "@evs/core/storage";

/**
 * How media objects (segments, subtitles, sprites, posters) reach the viewer.
 *
 * Segments are AES-128 encrypted, so the key endpoint is the primary gate. The
 * delivery driver adds a second, independent one: every object URL handed to a
 * player is time-limited and scoped to one video, so the media bucket itself is
 * never public and a scraped segment list stops working when the token expires.
 *
 * `urlsFor` takes a BATCH of paths because a variant playlist can reference
 * hundreds of segments; drivers amortise signing across the batch.
 */
export interface DeliveryDriver {
  readonly name: string;
  /**
   * @param videoId   the video whose output tree the paths live in
   * @param paths     paths relative to media/{videoId}/ (e.g. "hls/720/seg_00001.ts")
   * @param ttlSeconds remaining lifetime of the viewer's playback token
   * @param token     the playback token (only the proxy driver embeds it)
   */
  urlsFor(videoId: string, paths: string[], ttlSeconds: number, token: string): Promise<string[]>;
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/**
 * CloudFront signed URLs with ONE custom policy per batch.
 *
 * A canned policy is per-URL, i.e. one RSA signature per segment: about 1ms
 * each, so a 900-segment playlist would cost ~1s of CPU per request. A custom
 * policy whose Resource is the wildcard `${base}/media/{id}/*` is signed ONCE
 * and its Policy/Signature/Key-Pair-Id query string is appended to every URL.
 * The signature still only unlocks this one video's tree, until expiry.
 */
export class CloudFrontSignedDriver implements DeliveryDriver {
  readonly name = "cloudfront-signed";

  constructor(
    private readonly base: string,
    private readonly keyPairId: string,
    private readonly privateKey: string
  ) {}

  signingQuery(videoId: string, ttlSeconds: number, nowMs = Date.now()): string {
    const resource = `${this.base}/${objectKeys.outputPrefix(videoId)}/*`;
    const policy = JSON.stringify({
      Statement: [
        { Resource: resource, Condition: { DateLessThan: { "AWS:EpochTime": Math.floor(nowMs / 1000) + ttlSeconds } } },
      ],
    });
    const signed = getSignedUrl({
      url: `${this.base}/`,
      keyPairId: this.keyPairId,
      privateKey: this.privateKey,
      policy,
      algorithm: "SHA256",
    });
    return new URL(signed).search.slice(1);
  }

  async urlsFor(videoId: string, paths: string[], ttlSeconds: number, _token?: string): Promise<string[]> {
    const query = this.signingQuery(videoId, ttlSeconds);
    const prefix = `${this.base}/${objectKeys.outputPrefix(videoId)}`;
    return paths.map((p) => `${prefix}/${encodePath(p)}?${query}`);
  }
}

/**
 * S3 presigned GET per object. Signing is local HMAC (no network), so a few
 * hundred per playlist is cheap. Works anywhere S3 SigV4 works: the local
 * emulator, MinIO, Cloudflare R2.
 */
export class PresignedDriver implements DeliveryDriver {
  readonly name = "presigned";

  async urlsFor(videoId: string, paths: string[], ttlSeconds: number, _token?: string): Promise<string[]> {
    const prefix = objectKeys.outputPrefix(videoId);
    return Promise.all(paths.map((p) => storage.presignGet("media", `${prefix}/${p}`, ttlSeconds)));
  }
}

/**
 * The API streams objects itself after verifying the token on every request.
 * Simplest to operate (no CDN, no bucket CORS) at the cost of serving the bytes.
 */
export class ProxyDriver implements DeliveryDriver {
  readonly name = "proxy";

  constructor(private readonly apiBase: string) {}

  async urlsFor(videoId: string, paths: string[], _ttl: number, token: string): Promise<string[]> {
    const t = encodeURIComponent(token);
    return paths.map(
      (p) => `${this.apiBase}/v1/play/${encodeURIComponent(videoId)}/media/${encodePath(p)}?token=${t}`
    );
  }
}

/** Unsigned public URLs. Testing only: anyone with a segment URL can fetch it. */
export class PublicDriver implements DeliveryDriver {
  readonly name = "public";

  constructor(private readonly base: string) {}

  async urlsFor(videoId: string, paths: string[], _ttl?: number, _token?: string): Promise<string[]> {
    const prefix = `${this.base}/${objectKeys.outputPrefix(videoId)}`;
    return paths.map((p) => `${prefix}/${encodePath(p)}`);
  }
}

let driver: DeliveryDriver | null = null;

export const getDeliveryDriver = (): DeliveryDriver => {
  if (driver) return driver;
  const cfg = getApiConfig();
  switch (cfg.DELIVERY_DRIVER) {
    case "cloudfront-signed":
      driver = new CloudFrontSignedDriver(
        cfg.MEDIA_PUBLIC_BASE as string,
        cfg.CLOUDFRONT_KEY_PAIR_ID as string,
        cfg.CLOUDFRONT_PRIVATE_KEY as string
      );
      break;
    case "proxy":
      driver = new ProxyDriver(cfg.PUBLIC_API_BASE);
      break;
    case "public":
      driver = new PublicDriver(cfg.MEDIA_PUBLIC_BASE as string);
      break;
    default:
      driver = new PresignedDriver();
  }
  return driver;
};
