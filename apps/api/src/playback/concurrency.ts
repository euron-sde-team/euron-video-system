/**
 * What happens when a viewer starts more concurrent playback sessions than the
 * video's policy allows (playback_policies.max_concurrent_sessions)?
 *
 * This is a product decision, kept in one small, pure function so it is easy to
 * change and to test:
 *
 *   - "evict oldest" (the default below): the new session always succeeds and
 *     the oldest active sessions are revoked to make room. Good UX for the
 *     honest user who switched from laptop to phone; account sharing still
 *     self-limits because sharers keep kicking each other off.
 *   - "reject new": return { allow: false } and the newest device gets a 409.
 *     Stricter anti-sharing, but a user whose old tab is still open is locked
 *     out until that session expires.
 *
 * @param activeSessions the viewer's live sessions, OLDEST FIRST
 * @param limit          max concurrent sessions (0 = unlimited)
 * @returns allow, and the session ids to revoke before issuing the new one
 */
export interface ActiveSession {
  id: string;
  issuedAt: Date;
}

export interface ConcurrencyDecision {
  allow: boolean;
  revokeIds: string[];
}

export const resolveConcurrencyLimit = (activeSessions: ActiveSession[], limit: number): ConcurrencyDecision => {
  if (limit <= 0 || activeSessions.length < limit) return { allow: true, revokeIds: [] };
  // Make room for the new session: keep the newest (limit - 1), revoke the rest.
  const excess = activeSessions.length - (limit - 1);
  return { allow: true, revokeIds: activeSessions.slice(0, excess).map((s) => s.id) };
};
