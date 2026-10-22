import type { Request } from "express";
import { getApiConfig } from "@evs/core/config";
import { hmacSha256Hex } from "@evs/core/crypto";
import type { ActorType } from "@evs/core/db";

/** Who did something, as recorded on audit events. */
export interface Actor {
  type: ActorType;
  id: string | null;
  ipHash: string | null;
  requestId: string | null;
}

let ipKey: string | null = null;

/**
 * Keyed hash of a client IP. Raw IPs are personal data and never stored; a
 * keyed (not plain) hash means the 2^32 IPv4 space cannot be brute-forced back
 * from a database dump without the pepper.
 */
export const hashIp = (ip: string | undefined | null): string | null => {
  if (!ip) return null;
  ipKey ??= hmacSha256Hex(getApiConfig().API_KEY_PEPPER, "evs/ip-hash/v1");
  return hmacSha256Hex(ipKey, ip);
};

export const actorOf = (req: Request): Actor => ({
  type: "api_key",
  id: req.auth?.apiKeyId ?? null,
  ipHash: hashIp(req.ip),
  requestId: req.requestId ?? null,
});

export const SYSTEM_ACTOR: Actor = { type: "system", id: null, ipHash: null, requestId: null };
