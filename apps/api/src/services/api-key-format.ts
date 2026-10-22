import { randomBytes } from "node:crypto";
import { hmacSha256Hex, safeEqual } from "@evs/core/crypto";

/**
 * API key format: `evs_<prefix>_<secret>`
 *
 *   prefix  8 lowercase alphanumerics, unique, stored in clear: the lookup handle
 *           and what the console shows ("evs_ab12cd34_…"). Not a secret.
 *   secret  32 random bytes, base64url (43 chars). Never stored.
 *
 * Only HMAC-SHA256(pepper, fullKey) is persisted. A database dump without the
 * pepper (which lives in the secrets manager, not the database) cannot be used
 * to forge or verify keys offline. A fixed `evs_` prefix lets secret scanners
 * (GitHub push protection, gitleaks) recognise leaked keys.
 */
export const SCOPES = [
  "videos:read",
  "videos:write",
  "playback:mint",
  "policies:manage",
  "webhooks:manage",
  "keys:manage",
  "audit:read",
  "usage:read",
] as const;
export type Scope = (typeof SCOPES)[number];
export const WILDCARD_SCOPE = "*";

const KEY_PATTERN = /^evs_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const generatePrefix = (): string => {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join("");
};

export const generateApiKey = (): { prefix: string; secret: string; fullKey: string } => {
  const prefix = generatePrefix();
  const secret = randomBytes(32).toString("base64url");
  return { prefix, secret, fullKey: `evs_${prefix}_${secret}` };
};

/** Split a presented key into its prefix, or null when it is not even shaped like a key. */
export const parseApiKey = (presented: string): { prefix: string } | null => {
  const m = KEY_PATTERN.exec(presented);
  return m ? { prefix: m[1] as string } : null;
};

export const hashApiKey = (pepper: string, fullKey: string): string => hmacSha256Hex(pepper, fullKey);

export const verifyApiKey = (pepper: string, fullKey: string, storedHash: string): boolean =>
  safeEqual(hashApiKey(pepper, fullKey), storedHash);

/** True when `granted` covers every scope in `required`. "*" grants everything. */
export const hasScopes = (granted: readonly string[], required: readonly string[]): boolean =>
  granted.includes(WILDCARD_SCOPE) || required.every((s) => granted.includes(s));

/** A creator cannot mint a key with more power than it holds itself. */
export const canGrant = (creatorScopes: readonly string[], requested: readonly string[]): boolean =>
  creatorScopes.includes(WILDCARD_SCOPE) ||
  (!requested.includes(WILDCARD_SCOPE) && requested.every((s) => creatorScopes.includes(s)));
