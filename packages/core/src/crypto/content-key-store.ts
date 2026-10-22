import { ulid } from "ulid";
import { getDb } from "../db/index.js";
import { contentKeys, type ContentKey, type WrapScheme } from "./index.js";

/**
 * Persistence for per-video content keys. The worker generates + wraps + stores
 * at package time; the API loads + unwraps on each authorized key request. Only
 * the wrapped form ever touches the database.
 */
export const contentKeyStore = {
  /** Worker: generate, wrap, upsert. Returns the RAW key for the packager (never persisted raw). */
  async generateAndStore(videoId: string): Promise<ContentKey> {
    const key = contentKeys.generate();
    const wrapped = await contentKeys.wrap(videoId, key.keyBytes);
    await getDb()
      .insertInto("content_keys")
      .values({
        id: ulid(),
        video_id: videoId,
        kid_hex: key.kidHex,
        wrapped_key: wrapped.wrappedKey,
        wrap_scheme: wrapped.scheme,
        kms_key_ref: wrapped.kmsKeyRef,
      })
      .onConflict((oc) =>
        // A re-transcode (retry after failure) produces a NEW key; the old
        // segments it protected are overwritten by the same run.
        oc.column("video_id").doUpdateSet((eb) => ({
          kid_hex: key.kidHex,
          wrapped_key: wrapped.wrappedKey,
          wrap_scheme: wrapped.scheme,
          kms_key_ref: wrapped.kmsKeyRef,
          key_version: eb("content_keys.key_version", "+", 1),
          rotated_at: new Date(),
        }))
      )
      .execute();
    return key;
  },

  /** API: load + unwrap. Null when the video has no key yet. */
  async load(videoId: string): Promise<ContentKey | null> {
    const row = await getDb()
      .selectFrom("content_keys")
      .select(["kid_hex", "wrapped_key", "wrap_scheme"])
      .where("video_id", "=", videoId)
      .executeTakeFirst();
    if (!row) return null;
    const keyBytes = await contentKeys.unwrap(videoId, row.wrapped_key, row.wrap_scheme as WrapScheme);
    return { kidHex: row.kid_hex, keyBytes };
  },
};
