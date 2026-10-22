import { ulid } from "ulid";
import { getApiConfig } from "@evs/core/config";
import { objectKeys } from "@evs/core/constants";
import { getDb } from "@evs/core/db";
import { ForbiddenError, NotFoundError, UnauthorizedError, UnprocessableError } from "@evs/core/errors";
import { storage } from "@evs/core/storage";
import { iso } from "../http/pagination.js";
import { resolveConcurrencyLimit } from "../playback/concurrency.js";
import { signPlaybackToken, verifyPlaybackToken, type Keyring, type PlaybackClaims } from "../playback/token.js";
import policiesRepository, { type PolicyRow } from "../repositories/policies.repository.js";
import sessionsRepository, { type SessionRow } from "../repositories/sessions.repository.js";
import usageRepository from "../repositories/usage.repository.js";
import videosRepository from "../repositories/videos.repository.js";

export interface SessionResponse {
  id: string;
  videoId: string;
  viewerId: string;
  policyId: string | null;
  origin: string | null;
  userAgent: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  active: boolean;
}

export const toSessionResponse = (r: SessionRow): SessionResponse => ({
  id: r.id,
  videoId: r.video_id,
  viewerId: r.viewer_id,
  policyId: r.policy_id,
  origin: r.origin,
  userAgent: r.user_agent,
  issuedAt: iso(r.issued_at),
  expiresAt: iso(r.expires_at),
  revokedAt: iso(r.revoked_at),
  revokedReason: r.revoked_reason,
  active: !r.revoked_at && r.expires_at > new Date(),
});

export interface MintedSession {
  sessionId: string;
  token: string;
  expiresAt: string;
  manifestUrl: string;
  thumbnailsUrl: string;
  posterUrl: string;
  /**
   * Short-lived URL for the processed MP4, present only when the video's
   * playback policy sets allowDownload and the MP4 is ready. It expires with
   * the session. (Operators can always fetch it with GET /v1/videos/{id}/download.)
   */
  downloadUrl: string | null;
  watermark: { required: boolean; text: string };
}

/** Verified delivery context for one playback request. */
export interface DeliveryContext {
  claims: PlaybackClaims;
  token: string;
  /** Seconds until the token expires: signed media URLs never outlive it. */
  remainingSeconds: number;
  policy: PolicyRow | null;
}

/**
 * Revocation lookups are cached for a few seconds on the hot delivery path
 * (each viewer fetches a variant playlist every few seconds for live-style
 * refresh and on every quality switch). This bounds revocation lag to
 * LIVENESS_TTL_MS while keeping playlist and key requests off the database
 * almost entirely.
 */
const LIVENESS_TTL_MS = 5_000;
const POLICY_TTL_MS = 30_000;

class PlaybackService {
  private liveness = new Map<string, { live: boolean; policyId: string | null; until: number }>();
  private policies = new Map<string, { row: PolicyRow | null; until: number }>();

  keyring(): Keyring {
    const cfg = getApiConfig();
    return { keys: cfg.PLAYBACK_SIGNING_KEYS, activeKid: cfg.PLAYBACK_ACTIVE_KID, issuer: cfg.PLAYBACK_TOKEN_ISSUER };
  }

  /**
   * Mint a playback session for one viewer of one video.
   *
   * The CALLER is responsible for entitlement (is this viewer allowed to watch
   * this video?); this service enforces the video's playback policy on top:
   * token lifetime, allowed embedding origins, and concurrent-session limits.
   */
  async mint(
    videoId: string,
    input: { viewerId: string; ttlSeconds?: number; origin?: string },
    client: { ipHash: string | null; userAgent: string | null }
  ): Promise<MintedSession> {
    const video = await videosRepository.findById(videoId);
    if (!video) throw new NotFoundError("Video not found");
    if (video.status !== "ready") throw new UnprocessableError(`Video is not ready (status: ${video.status})`);

    const policy = await policiesRepository.effectiveFor(video.playback_policy_id);
    const origin = input.origin ? normalizeOrigin(input.origin) : null;
    if (policy && policy.allowed_origins.length > 0 && (!origin || !policy.allowed_origins.includes(origin))) {
      throw new ForbiddenError("Origin is not allowed by this video's playback policy");
    }

    const defaultTtl = policy?.token_ttl_seconds ?? 300;
    const maxTtl = policy?.max_token_ttl_seconds ?? 3600;
    const ttl = Math.max(10, Math.min(input.ttlSeconds ?? defaultTtl, maxTtl));
    const sessionId = `ps_${ulid()}`;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await getDb()
      .transaction()
      .execute(async (trx) => {
        const limit = policy?.max_concurrent_sessions ?? 0;
        if (limit > 0) {
          const active = await sessionsRepository.activeForViewerForUpdate(input.viewerId, trx);
          const decision = resolveConcurrencyLimit(
            active.map((s) => ({ id: s.id, issuedAt: s.issued_at })),
            limit
          );
          if (!decision.allow) throw new ForbiddenError("Concurrent playback session limit reached");
          await sessionsRepository.revokeMany(decision.revokeIds, "concurrency_limit", trx);
          for (const id of decision.revokeIds) this.liveness.delete(id);
        }
        await sessionsRepository.create(
          {
            id: sessionId,
            videoId,
            viewerId: input.viewerId,
            policyId: policy?.id ?? null,
            origin,
            ipHash: client.ipHash,
            userAgent: client.userAgent?.slice(0, 512) ?? null,
            expiresAt,
          },
          trx
        );
        await usageRepository.increment("playback_sessions", 1, trx);
      });

    const token = signPlaybackToken(this.keyring(), { viewerId: input.viewerId, videoId, sessionId, ttlSeconds: ttl });
    const base = `${getApiConfig().PUBLIC_API_BASE}/v1/play/${encodeURIComponent(videoId)}`;
    const t = encodeURIComponent(token);
    // allowDownload is enforced here: viewers only ever receive a download URL
    // through a session minted under a policy that permits it.
    const downloadUrl =
      policy?.allow_download && video.mp4_status === "ready"
        ? await storage.presignGet(
            "downloads",
            objectKeys.download(videoId),
            ttl,
            `${video.title.replace(/[^\w.-]+/g, "_").slice(0, 120) || `video-${videoId.slice(0, 8)}`}.mp4`
          )
        : null;
    return {
      sessionId,
      token,
      expiresAt: expiresAt.toISOString(),
      manifestUrl: `${base}/master.m3u8?token=${t}`,
      thumbnailsUrl: `${base}/thumbnails.vtt?token=${t}`,
      posterUrl: `${base}/poster.jpg?token=${t}`,
      downloadUrl,
      watermark: {
        required: policy?.watermark_required ?? video.watermark !== "none",
        // The watermark identifies the viewer, deterring screen capture by
        // making every leaked recording attributable.
        text: input.viewerId,
      },
    };
  }

  /**
   * Full verification for one delivery request: signature + kid + aud + exp,
   * the token is for THIS video, the session is not revoked, and the request
   * Origin (when a browser sends one) is allowed by the session's policy.
   */
  async verifyForDelivery(token: string, videoId: string, origin: string | undefined): Promise<DeliveryContext> {
    const claims = verifyPlaybackToken(this.keyring(), token);
    if (claims.vid !== videoId) throw new ForbiddenError("Token is not valid for this video");

    const live = await this.sessionLiveness(claims.jti);
    if (!live.live) throw new UnauthorizedError("Playback session revoked or expired");

    const policy = live.policyId ? await this.cachedPolicy(live.policyId) : null;
    if (origin && policy && policy.allowed_origins.length > 0 && !policy.allowed_origins.includes(normalizeOrigin(origin))) {
      throw new ForbiddenError("Origin is not allowed by this video's playback policy");
    }
    return { claims, token, remainingSeconds: Math.max(1, claims.exp - Math.floor(Date.now() / 1000)), policy };
  }

  private async sessionLiveness(sessionId: string): Promise<{ live: boolean; policyId: string | null }> {
    const hit = this.liveness.get(sessionId);
    if (hit && hit.until > Date.now()) return hit;
    const row = await sessionsRepository.liveness(sessionId);
    const entry = {
      live: Boolean(row && !row.revoked && row.expiresAt > new Date()),
      policyId: row?.policyId ?? null,
      until: Date.now() + LIVENESS_TTL_MS,
    };
    if (this.liveness.size > 50_000) this.liveness.clear();
    this.liveness.set(sessionId, entry);
    return entry;
  }

  private async cachedPolicy(id: string): Promise<PolicyRow | null> {
    const hit = this.policies.get(id);
    if (hit && hit.until > Date.now()) return hit.row;
    const row = await policiesRepository.findById(id);
    this.policies.set(id, { row, until: Date.now() + POLICY_TTL_MS });
    return row;
  }

  async list(params: { videoId?: string; viewerId?: string; active?: boolean; page: number; limit: number }) {
    const { rows, total } = await sessionsRepository.list(params);
    return { rows: rows.map(toSessionResponse), total };
  }

  async revoke(id: string, reason = "revoked_by_api"): Promise<SessionResponse> {
    const row = await sessionsRepository.findById(id);
    if (!row) throw new NotFoundError("Playback session not found");
    await sessionsRepository.revokeMany([id], reason);
    this.liveness.delete(id);
    return toSessionResponse((await sessionsRepository.findById(id)) as SessionRow);
  }
}

/** "https://App.Example.com:443/path" -> "https://app.example.com". */
export const normalizeOrigin = (raw: string): string => {
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
};

export default new PlaybackService();
