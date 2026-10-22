import { describe, expect, it } from "vitest";
import { contentKeys, safeEqual, sealedSecrets } from "../src/crypto/index.js";

describe("content keys (local AES-256-GCM wrap)", () => {
  it("generates 16-byte keys and 16-byte key ids", () => {
    const key = contentKeys.generate();
    expect(key.keyBytes).toHaveLength(16);
    expect(key.kidHex).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never generates the same key twice", () => {
    const seen = new Set(Array.from({ length: 256 }, () => contentKeys.generate().keyBytes.toString("hex")));
    expect(seen.size).toBe(256);
  });

  it("round-trips through wrap and unwrap", async () => {
    const { keyBytes } = contentKeys.generate();
    const wrapped = await contentKeys.wrap("vid_1", keyBytes);
    expect(wrapped.scheme).toBe("local_aes");
    expect(wrapped.kmsKeyRef).toBeNull();
    expect(wrapped.wrappedKey).not.toContain(keyBytes.toString("base64"));
    await expect(contentKeys.unwrap("vid_1", wrapped.wrappedKey, wrapped.scheme)).resolves.toEqual(keyBytes);
  });

  it("binds the wrapped key to its video: moving it to another video fails", async () => {
    const { keyBytes } = contentKeys.generate();
    const wrapped = await contentKeys.wrap("vid_1", keyBytes);
    await expect(contentKeys.unwrap("vid_2", wrapped.wrappedKey, wrapped.scheme)).rejects.toThrow();
  });

  it("detects tampering with the ciphertext", async () => {
    const { keyBytes } = contentKeys.generate();
    const wrapped = await contentKeys.wrap("vid_1", keyBytes);
    const raw = Buffer.from(wrapped.wrappedKey, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    await expect(contentKeys.unwrap("vid_1", raw.toString("base64"), "local_aes")).rejects.toThrow();
  });

  it("refuses a KMS-wrapped key when KMS is not configured", async () => {
    await expect(contentKeys.unwrap("vid_1", "AAAA", "kms")).rejects.toThrow(/KMS_KEY_ID/);
  });
});

describe("sealed secrets", () => {
  it("round-trips and is context-bound", () => {
    const sealed = sealedSecrets.seal("whsec_example", "wh_1");
    expect(sealedSecrets.open(sealed, "wh_1")).toBe("whsec_example");
    expect(() => sealedSecrets.open(sealed, "wh_2")).toThrow();
  });

  it("uses a fresh IV every time", () => {
    expect(sealedSecrets.seal("same", "ctx")).not.toBe(sealedSecrets.seal("same", "ctx"));
  });
});

describe("safeEqual", () => {
  it("compares by value, including length mismatches", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
