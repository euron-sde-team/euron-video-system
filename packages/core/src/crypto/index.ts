import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { getCoreConfig } from "../config/index.js";

/**
 * Key hierarchy (docs/architecture/security.md#key-hierarchy):
 *
 *   KMS CMK (never leaves KMS)
 *     └─ wraps ─> per-video AES-128 content key   (content_keys.wrapped_key)
 *                   └─ encrypts ─> every HLS segment of that video
 *
 *   DATA_ENCRYPTION_KEY (deployment secret)
 *     ├─ HKDF "evs/content-key-wrap/v1" ─> local wrap key (only when KMS is not configured)
 *     └─ HKDF "evs/secret-seal/v1"      ─> seals webhook signing secrets at rest
 *
 * HKDF domain separation means no secret is ever used directly for two
 * purposes, so compromising one derived key reveals nothing about the others.
 */

export type WrapScheme = "kms" | "local_aes";

const derive = (purpose: string): Buffer =>
  Buffer.from(hkdfSync("sha256", getCoreConfig().DATA_ENCRYPTION_KEY, Buffer.alloc(0), purpose, 32));

let kms: KMSClient | null | undefined;
const getKms = (): KMSClient | null => {
  if (kms !== undefined) return kms;
  const cfg = getCoreConfig();
  kms = cfg.KMS_KEY_ID ? new KMSClient({ region: cfg.AWS_REGION }) : null;
  return kms;
};

// ─── AES-256-GCM sealing: base64( iv(12) || tag(16) || ciphertext ) ──────────

const gcmSeal = (key: Buffer, plaintext: Buffer, aad?: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
};

const gcmOpen = (key: Buffer, sealed: string, aad?: string): Buffer => {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
};

// ─── Content keys ────────────────────────────────────────────────────────────

export interface ContentKey {
  kidHex: string; // 16-byte key id, hex
  keyBytes: Buffer; // 16-byte AES-128 content key
}

export interface WrappedContentKey {
  wrappedKey: string;
  scheme: WrapScheme;
  kmsKeyRef: string | null;
}

export const contentKeys = {
  /** Fresh random 16-byte key + 16-byte key id, from the OS CSPRNG. */
  generate(): ContentKey {
    return { kidHex: randomBytes(16).toString("hex"), keyBytes: randomBytes(16) };
  },

  /**
   * Envelope-encrypt a content key. With KMS the video id is bound as
   * EncryptionContext, so a wrapped key copied onto another video's row fails
   * to decrypt, and every Decrypt is attributable in CloudTrail by video.
   */
  async wrap(videoId: string, keyBytes: Buffer): Promise<WrappedContentKey> {
    const cfg = getCoreConfig();
    const client = getKms();
    if (client && cfg.KMS_KEY_ID) {
      const out = await client.send(
        new EncryptCommand({ KeyId: cfg.KMS_KEY_ID, Plaintext: keyBytes, EncryptionContext: { videoId } })
      );
      if (!out.CiphertextBlob) throw new Error("KMS returned no ciphertext");
      return {
        wrappedKey: Buffer.from(out.CiphertextBlob).toString("base64"),
        scheme: "kms",
        kmsKeyRef: out.KeyId ?? cfg.KMS_KEY_ID,
      };
    }
    // Same binding for the local scheme: the video id is GCM additional data.
    return {
      wrappedKey: gcmSeal(derive("evs/content-key-wrap/v1"), keyBytes, videoId),
      scheme: "local_aes",
      kmsKeyRef: null,
    };
  },

  async unwrap(videoId: string, wrappedKey: string, scheme: WrapScheme): Promise<Buffer> {
    if (scheme === "kms") {
      const client = getKms();
      if (!client) throw new Error("content key is KMS-wrapped but KMS_KEY_ID is not configured");
      const out = await client.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(wrappedKey, "base64"), EncryptionContext: { videoId } })
      );
      if (!out.Plaintext) throw new Error("KMS returned no plaintext");
      return Buffer.from(out.Plaintext);
    }
    return gcmOpen(derive("evs/content-key-wrap/v1"), wrappedKey, videoId);
  },
};

// ─── Sealed secrets (webhook signing secrets at rest) ────────────────────────

export const sealedSecrets = {
  seal: (plaintext: string, context: string): string =>
    gcmSeal(derive("evs/secret-seal/v1"), Buffer.from(plaintext, "utf8"), context),
  open: (sealed: string, context: string): string =>
    gcmOpen(derive("evs/secret-seal/v1"), sealed, context).toString("utf8"),
};

// ─── Small primitives ────────────────────────────────────────────────────────

export const hmacSha256Hex = (key: string | Buffer, data: string): string =>
  createHmac("sha256", key).update(data).digest("hex");

export const sha256Hex = (data: string): string => createHash("sha256").update(data).digest("hex");

/** Constant-time comparison of two hex/ASCII strings. */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

/** URL-safe random token of `bytes` entropy. */
export const randomToken = (bytes = 24): string => randomBytes(bytes).toString("base64url");
