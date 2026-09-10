import type { FeedName } from './types.js';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

export interface CatalogPolicy {
  refreshEveryMs: number;
  freshForMs: number;
  retainForMs: number;
}

/** Refresh, soft-expiry and last-known-good retention policy for each catalog feed. */
export const CATALOG_POLICY: Record<FeedName, CatalogPolicy> = {
  latest: {
    refreshEveryMs: DAY,
    freshForMs: 36 * HOUR,
    retainForMs: 7 * DAY,
  },
  popular: {
    refreshEveryMs: 3 * DAY,
    freshForMs: 4 * DAY,
    retainForMs: 14 * DAY,
  },
  top_rated: {
    refreshEveryMs: 7 * DAY,
    freshForMs: 8 * DAY,
    retainForMs: 30 * DAY,
  },
};

const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, HOUR, 6 * HOUR] as const;

/** Returns exponential-style backoff: 5m, 15m, 1h, then 6h for subsequent failures. */
export function retryDelayMs(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures, 1) - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? 6 * HOUR;
}
