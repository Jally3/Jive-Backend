import { describe, expect, it, vi } from 'vitest';
import { TmdbClient } from '../src/tmdb-client.js';

describe('TmdbClient detail cache', () => {
  it('coalesces in-flight detail requests and reuses the successful result', async () => {
    const monitoring = {
      recordHttp: vi.fn(),
      recordTmdb: vi.fn(),
      recordTmdbCache: vi.fn(),
      recordCatalogRefresh: vi.fn(),
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, production_countries: [{ iso_3166_1: 'US' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TmdbClient({
      token: 'secret',
      baseUrl: 'https://example.test/3',
      concurrency: 4,
      pages: 1,
      timeoutMs: 1_000,
      fetch: fetchMock,
      monitoring,
    });

    const [first, second] = await Promise.all([client.movieDetail(42), client.movieDetail(42)]);
    const third = await client.movieDetail(42);

    expect(first).toEqual(second);
    expect(third.id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.consumeDetailStats()).toMatchObject({
      cacheHits: 2,
      upstreamSuccesses: 1,
      failures: 0,
    });
    expect(monitoring.recordTmdb).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'movie/:id', success: true, attempts: 1 }),
    );
    expect(monitoring.recordTmdbCache).toHaveBeenNthCalledWith(1, 'miss');
    expect(monitoring.recordTmdbCache).toHaveBeenNthCalledWith(2, 'inflight_coalesced');
    expect(monitoring.recordTmdbCache).toHaveBeenNthCalledWith(3, 'hit');
  });
});
