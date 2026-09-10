import { describe, expect, it } from 'vitest';
import { CATALOG_POLICY, retryDelayMs } from '../src/catalog-policy.js';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

describe('catalog policy', () => {
  it('uses the requested refresh, soft-expiry and retention windows', () => {
    expect(CATALOG_POLICY).toEqual({
      latest: { refreshEveryMs: DAY, freshForMs: 36 * HOUR, retainForMs: 7 * DAY },
      popular: { refreshEveryMs: 3 * DAY, freshForMs: 4 * DAY, retainForMs: 14 * DAY },
      top_rated: { refreshEveryMs: 7 * DAY, freshForMs: 8 * DAY, retainForMs: 30 * DAY },
    });
  });

  it('backs off failed refreshes and caps retries at six hours', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([
      5 * 60_000,
      15 * 60_000,
      HOUR,
      6 * HOUR,
      6 * HOUR,
    ]);
  });
});
