import jwt, { type JwtHeader } from "jsonwebtoken";
import { UnauthorizedError } from "@evs/core/errors";

/**
 * Playback tokens: short-lived HS256 JWTs bound to one viewer, one video and one
 * playback session.
 *
 *   header  { alg: "HS256", kid }      kid selects the key from the keyring
 *   claims  { sub: viewerId, vid: videoId, jti: sessionId, iss, aud: "evs-playback", iat, exp }
 *
 * Signing uses the ACTIVE kid; verification accepts any kid still in the ring.
 * Rotation is therefore: add the new key, switch PLAYBACK_ACTIVE_KID, wait one
 * max-TTL, remove the old key. No viewer is ever cut off mid-playback.
 *
 * The signature proves the API minted the token. It does NOT prove the session
 * is still live: revocation is checked separately against playback_sessions
 * (see playback-auth.middleware.ts), keyed by jti.
 */

export const PLAYBACK_AUDIENCE = "evs-playback";

export interface PlaybackClaims {
  sub: string;
  vid: string;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface Keyring {
  keys: Map<string, string>;
  activeKid: string;
  issuer: string;
}

export const signPlaybackToken = (
  ring: Keyring,
  input: { viewerId: string; videoId: string; sessionId: string; ttlSeconds: number }
): string => {
  const secret = ring.keys.get(ring.activeKid);
  if (!secret) throw new Error(`active playback kid ${ring.activeKid} is not in the keyring`);
  return jwt.sign({ vid: input.videoId }, secret, {
    algorithm: "HS256",
    keyid: ring.activeKid,
    subject: input.viewerId,
    jwtid: input.sessionId,
    issuer: ring.issuer,
    audience: PLAYBACK_AUDIENCE,
    expiresIn: input.ttlSeconds,
  });
};

export const verifyPlaybackToken = (ring: Keyring, token: string): PlaybackClaims => {
  const decoded = jwt.decode(token, { complete: true }) as { header: JwtHeader } | null;
  const kid = decoded?.header?.kid;
  const secret = kid ? ring.keys.get(kid) : undefined;
  if (!secret) throw new UnauthorizedError("Invalid playback token");
  try {
    const claims = jwt.verify(token, secret, {
      algorithms: ["HS256"], // pinned: never let the token choose its own algorithm
      audience: PLAYBACK_AUDIENCE,
      issuer: ring.issuer,
    }) as PlaybackClaims;
    if (!claims.vid || !claims.jti || !claims.sub) throw new Error("missing claims");
    return claims;
  } catch (err) {
    const expired = (err as Error).name === "TokenExpiredError";
    throw new UnauthorizedError(expired ? "Playback token expired" : "Invalid playback token");
  }
};
