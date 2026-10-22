import { describe, expect, it } from "vitest";
import {
  canGrant,
  generateApiKey,
  hashApiKey,
  hasScopes,
  parseApiKey,
  verifyApiKey,
} from "../src/services/api-key-format.js";

const PEPPER = "p".repeat(40);

describe("API key format", () => {
  it("generates evs_<8>_<43> keys whose prefix parses back out", () => {
    const k = generateApiKey();
    expect(k.fullKey).toMatch(/^evs_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(k.fullKey)).toEqual({ prefix: k.prefix });
  });

  it("rejects malformed keys before any lookup", () => {
    for (const bad of ["", "evs_short_x", "sk_live_abc", `evs_ABCDEFGH_${"a".repeat(43)}`, `evs_abcdefgh_${"a".repeat(42)}`]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it("hashes with the pepper and verifies in constant time", () => {
    const k = generateApiKey();
    const hash = hashApiKey(PEPPER, k.fullKey);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKey(PEPPER, k.fullKey, hash)).toBe(true);
    expect(verifyApiKey("q".repeat(40), k.fullKey, hash)).toBe(false); // wrong pepper
    expect(verifyApiKey(PEPPER, generateApiKey().fullKey, hash)).toBe(false);
  });
});

describe("scopes", () => {
  it("requires every listed scope; '*' grants all", () => {
    expect(hasScopes(["videos:read"], ["videos:read"])).toBe(true);
    expect(hasScopes(["videos:read"], ["videos:write"])).toBe(false);
    expect(hasScopes(["videos:read"], ["videos:read", "videos:write"])).toBe(false);
    expect(hasScopes(["*"], ["keys:manage", "audit:read"])).toBe(true);
  });

  it("forbids privilege escalation when minting keys", () => {
    expect(canGrant(["keys:manage", "videos:read"], ["videos:read"])).toBe(true);
    expect(canGrant(["keys:manage", "videos:read"], ["videos:write"])).toBe(false);
    expect(canGrant(["keys:manage", "videos:read"], ["*"])).toBe(false);
    expect(canGrant(["*"], ["*"])).toBe(true);
  });
});
