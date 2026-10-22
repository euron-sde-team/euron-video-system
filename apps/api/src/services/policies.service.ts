import { ulid } from "ulid";
import { getDb } from "@evs/core/db";
import { BadRequestError, ConflictError, NotFoundError } from "@evs/core/errors";
import policiesRepository, { type PolicyFields, type PolicyRow } from "../repositories/policies.repository.js";
import { iso } from "../http/pagination.js";

export interface PolicyResponse {
  id: string;
  name: string;
  isDefault: boolean;
  tokenTtlSeconds: number;
  maxTokenTtlSeconds: number;
  allowedOrigins: string[];
  maxConcurrentSessions: number;
  watermarkRequired: boolean;
  allowDownload: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export const toPolicyResponse = (r: PolicyRow): PolicyResponse => ({
  id: r.id,
  name: r.name,
  isDefault: r.is_default,
  tokenTtlSeconds: r.token_ttl_seconds,
  maxTokenTtlSeconds: r.max_token_ttl_seconds,
  allowedOrigins: r.allowed_origins,
  maxConcurrentSessions: r.max_concurrent_sessions,
  watermarkRequired: r.watermark_required,
  allowDownload: r.allow_download,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === "23505";

class PoliciesService {
  async list(): Promise<PolicyResponse[]> {
    return (await policiesRepository.list()).map(toPolicyResponse);
  }

  async get(id: string): Promise<PolicyResponse> {
    const row = await policiesRepository.findById(id);
    if (!row) throw new NotFoundError("Playback policy not found");
    return toPolicyResponse(row);
  }

  async create(fields: PolicyFields & { isDefault?: boolean }): Promise<PolicyResponse> {
    if (fields.tokenTtlSeconds > fields.maxTokenTtlSeconds) {
      throw new BadRequestError("tokenTtlSeconds cannot exceed maxTokenTtlSeconds");
    }
    try {
      const row = await getDb()
        .transaction()
        .execute(async (trx) => {
          const created = await policiesRepository.create(`pol_${ulid()}`, fields, trx);
          if (fields.isDefault) await policiesRepository.setDefault(created.id, trx);
          return (await policiesRepository.findById(created.id, trx)) as PolicyRow;
        });
      return toPolicyResponse(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("A policy with that name already exists");
      throw err;
    }
  }

  async update(id: string, patch: Partial<PolicyFields> & { isDefault?: boolean }): Promise<PolicyResponse> {
    try {
      const row = await getDb()
        .transaction()
        .execute(async (trx) => {
          const current = await policiesRepository.findById(id, trx);
          if (!current) throw new NotFoundError("Playback policy not found");
          const ttl = patch.tokenTtlSeconds ?? current.token_ttl_seconds;
          const maxTtl = patch.maxTokenTtlSeconds ?? current.max_token_ttl_seconds;
          if (ttl > maxTtl) throw new BadRequestError("tokenTtlSeconds cannot exceed maxTokenTtlSeconds");
          if (patch.isDefault === false && current.is_default) {
            throw new BadRequestError("Make another policy the default instead of unsetting this one");
          }
          await policiesRepository.update(id, patch, trx);
          if (patch.isDefault) await policiesRepository.setDefault(id, trx);
          return (await policiesRepository.findById(id, trx)) as PolicyRow;
        });
      return toPolicyResponse(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("A policy with that name already exists");
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const row = await policiesRepository.findById(id);
    if (!row) throw new NotFoundError("Playback policy not found");
    if (row.is_default) throw new ConflictError("The default policy cannot be deleted");
    await policiesRepository.delete(id);
  }

  async assertExists(id: string): Promise<void> {
    if (!(await policiesRepository.findById(id))) throw new BadRequestError("playbackPolicyId does not exist");
  }
}

export default new PoliciesService();
