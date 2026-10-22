import { ulid } from "ulid";
import { getApiConfig } from "@evs/core/config";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@evs/core/errors";
import apiKeysRepository, { type ApiKeyRow } from "../repositories/api-keys.repository.js";
import { iso } from "../http/pagination.js";
import type { AuthContext } from "../types/express.js";
import { canGrant, generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from "./api-key-format.js";

export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const toResponse = (r: ApiKeyRow): ApiKeyResponse => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  revokedAt: iso(r.revoked_at),
  lastUsedAt: iso(r.last_used_at),
});

/** Verified keys are cached briefly so a busy integration costs no DB read per request. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1_000;

class ApiKeysService {
  private cache = new Map<string, { ctx: AuthContext; hash: string; until: number }>();

  /**
   * Resolve a presented bearer key to an AuthContext, or throw 401.
   *
   * The cache is keyed by the full key's HMAC (never the plaintext). A revoke
   * on this instance evicts immediately; other instances converge within
   * CACHE_TTL_MS, which is the documented upper bound on revocation lag.
   */
  async authenticate(presented: string): Promise<AuthContext> {
    const parsed = parseApiKey(presented);
    if (!parsed) throw new UnauthorizedError("Invalid API key");
    const pepper = getApiConfig().API_KEY_PEPPER;
    const hash = hashApiKey(pepper, presented);

    const hit = this.cache.get(hash);
    if (hit && hit.until > Date.now() && (!hit.ctx.expiresAt || hit.ctx.expiresAt > new Date())) return hit.ctx;

    const row = await apiKeysRepository.findByPrefix(parsed.prefix);
    // Same error for unknown, revoked, expired and wrong-secret: no oracle.
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= new Date()) || !verifyApiKey(pepper, presented, row.key_hash)) {
      throw new UnauthorizedError("Invalid API key");
    }

    const ctx: AuthContext = {
      apiKeyId: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(hash, { ctx, hash, until: Date.now() + CACHE_TTL_MS });
    void apiKeysRepository.touch(row.id).catch(() => undefined);
    return ctx;
  }

  async create(
    creator: AuthContext | null,
    input: { name: string; scopes: string[]; expiresAt?: string | null }
  ): Promise<{ apiKey: ApiKeyResponse; secret: string }> {
    if (creator && !canGrant(creator.scopes, input.scopes)) {
      throw new ForbiddenError("Cannot create a key with scopes you do not hold");
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) throw new BadRequestError("expiresAt must be in the future");

    const key = generateApiKey();
    const row = await apiKeysRepository.create({
      id: `key_${ulid()}`,
      name: input.name,
      prefix: key.prefix,
      keyHash: hashApiKey(getApiConfig().API_KEY_PEPPER, key.fullKey),
      scopes: [...new Set(input.scopes)],
      createdBy: creator?.apiKeyId ?? "cli",
      expiresAt,
    });
    return { apiKey: toResponse(row), secret: key.fullKey };
  }

  async list(includeRevoked: boolean): Promise<ApiKeyResponse[]> {
    return (await apiKeysRepository.list(includeRevoked)).map(toResponse);
  }

  async revoke(requester: AuthContext, id: string): Promise<void> {
    if (requester.apiKeyId === id) throw new ConflictError("A key cannot revoke itself");
    const ok = await apiKeysRepository.revoke(id);
    if (!ok) throw new NotFoundError("API key not found or already revoked");
    for (const [hash, entry] of this.cache) if (entry.ctx.apiKeyId === id) this.cache.delete(hash);
  }

  /** Test seam: forget cached verifications. */
  clearCache(): void {
    this.cache.clear();
  }
}

export default new ApiKeysService();
