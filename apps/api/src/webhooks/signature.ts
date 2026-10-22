import { hmacSha256Hex, safeEqual } from "@evs/core/crypto";

/**
 * Webhook request signing.
 *
 *   EVS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Signing the timestamp together with the body lets a receiver reject replays
 * (refuse t older than a few minutes) without a nonce store. The scheme is
 * versioned (v1) so a future algorithm can be added alongside, not instead.
 * docs/guides/webhooks.md shows receiver-side verification.
 */
export const signPayload = (secret: string, body: string, timestamp: number): string =>
  `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;

export const verifySignature = (
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300
): boolean => {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${body}`), parts.v1);
};
