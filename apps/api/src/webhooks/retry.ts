/**
 * Delay before the next webhook delivery attempt.
 *
 * Kept as one pure function because the schedule is a policy choice with real
 * trade-offs: retry too fast and a receiver that is briefly down gets hammered
 * the moment it recovers (thundering herd); too slow and integrations see
 * events minutes late after a blip.
 *
 * Default: exponential backoff (30s, 1m, 2m, 4m, ...) capped at 1 hour, with
 * "equal jitter" (half the computed delay fixed, plus a uniform random share of
 * the other half) so endpoints that failed together do not all retry in
 * lockstep, while no retry ever fires sooner than half its step. With
 * max_attempts = 8 there are 7 waits summing to 30s x (1 + 2 + ... + 64), so
 * the last attempt lands roughly 32-64 minutes after the event, which outlives
 * a typical deploy or brief outage.
 *
 * @param attempt the attempt number that just FAILED (1 = first delivery)
 * @param random  injectable for tests
 * @returns milliseconds to wait before the next attempt
 */
const BASE_MS = 30_000;
const CAP_MS = 60 * 60_000;

export const nextRetryDelay = (attempt: number, random: () => number = Math.random): number => {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
};
