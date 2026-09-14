import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { EncodedSnapshot } from '../src/catalog-service.js';
import { createCatalogServer, type CatalogReader } from '../src/http-server.js';
import { Logger } from '../src/logger.js';
import { MonitoringService } from '../src/monitoring-service.js';
import type { CatalogSnapshot, FeedName } from '../src/types.js';
import { RecommendationControls } from '../src/recommendation/controls.js';
import { RecommendationCursorCodec } from '../src/recommendation/cursor.js';
import { RecommendationService } from '../src/recommendation/service.js';
import { RecommendationMemoryStore } from '../src/recommendation/store.js';
import { AnonymousSubjectIssuer } from '../src/recommendation/subject.js';

const servers: ReturnType<typeof createCatalogServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

describe('catalog HTTP server', () => {
  it('serves dynamic compatibility routes with compression, ETag and 304', async () => {
    const encoded = fixture();
    const server = createCatalogServer({
      catalog: reader(encoded),
      logger: new Logger('error'),
      rateLimitPerMinute: 10,
      trustProxy: false,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const base = `http://127.0.0.1:${address.port}`;

    const first = await fetch(`${base}/data/tmdb/v1/popular.json`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe(encoded.etag);
    expect(((await first.json()) as { feed: string }).feed).toBe('popular');

    const unchanged = await fetch(`${base}/api/tmdb/v1/catalog?feed=popular`, {
      headers: { 'if-none-match': encoded.etag },
    });
    expect(unchanged.status).toBe(304);
  });

  it('rejects invalid feeds and reports readiness', async () => {
    const server = createCatalogServer({
      catalog: reader(fixture()),
      logger: new Logger('error'),
      rateLimitPerMinute: 10,
      trustProxy: false,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect((await fetch(`${base}/api/tmdb/v1/catalog?feed=wrong`)).status).toBe(400);
  });

  it('serves the manually refreshed admin overview and records normalized routes', async () => {
    const monitoring = new MonitoringService({
      logger: new Logger('error'),
      retentionDays: 90,
      timezone: 'Asia/Shanghai',
      saveIntervalMs: 60_000,
    });
    await monitoring.start();
    const server = createCatalogServer({
      catalog: reader(fixture()),
      logger: new Logger('error'),
      rateLimitPerMinute: 10,
      trustProxy: false,
      monitoring,
      adminEnabled: true,
      tmdbDiagnostics: () => ({ detailCacheEntries: 2 }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/admin`)).status).toBe(200);
    expect((await fetch(`${base}/api/tmdb/v1/catalog?feed=popular`)).status).toBe(200);
    const response = await fetch(`${base}/admin/api/overview?days=7`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.tmdb.detailCacheEntries).toBe(2);
    expect(body.history.days[0].metrics.http['catalog/popular'].requests).toBe(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const items = await fetch(
      `${base}/admin/api/catalog/items?feed=popular&group=movie&page=1&pageSize=20`,
    );
    expect(items.status).toBe(200);
    expect(((await items.json()) as { total: number }).total).toBe(1);
  });

  it('issues an anonymous subject and returns cold-start without calling Ark', async () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const issuer = new AnonymousSubjectIssuer(secret);
    let arkCalls = 0;
    const recommendation = new RecommendationService({
      enabled: true,
      promptVersion: 'v1',
      modelVersion: 'test',
      parameterVersion: 'test',
      maxOutputTokens: 1_000,
      minItemsForNextPage: 4,
      fingerprintSecret: secret,
      subjectIssuer: issuer,
      cursorCodec: new RecommendationCursorCodec(secret),
      store: new RecommendationMemoryStore({
        maxSessions: 10,
        maxCacheEntries: 10,
        sessionTtlMs: 1_800_000,
        freshTtlMs: 1_800_000,
        staleTtlMs: 86_400_000,
        cleanupIntervalMs: 60_000,
      }),
      controls: new RecommendationControls({
        subjectRateLimitPerMinute: 10,
        sourceRateLimitPerMinute: 10,
        maxRateLimitSubjects: 100,
        maxConcurrency: 1,
        maxQueue: 1,
      }),
      budget: {
        reserve: async () => ({
          subjectHash: 'unused',
          tokens: 0,
          costMicros: 0,
          date: '2026-09-13',
        }),
        settle: async () => undefined,
        diagnostics: () => ({ available: true }),
      },
      ark: {
        complete: async () => {
          arkCalls += 1;
          throw new Error('Ark must not be called for cold start');
        },
      },
      logger: new Logger('error'),
    });
    const server = createCatalogServer({
      catalog: reader(fixture()),
      logger: new Logger('error'),
      rateLimitPerMinute: 10,
      trustProxy: false,
      recommendation,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const base = `http://127.0.0.1:${address.port}`;
    const issuedResponse = await fetch(`${base}/api/v1/recommendations/anonymous-subject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const issued = (await issuedResponse.json()) as { anonymousSubjectId: string };
    expect(issuedResponse.status).toBe(201);
    const recommendationResponse = await fetch(`${base}/api/v1/recommendations/personalized`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jive-anonymous-subject': issued.anonymousSubjectId,
      },
      body: JSON.stringify({
        clientRequestId: '00000000-0000-4000-8000-000000000001',
        history: [],
        library: [],
      }),
    });
    const result = (await recommendationResponse.json()) as { mode: string };
    expect(recommendationResponse.status).toBe(200);
    expect(recommendationResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(result.mode).toBe('cold_start');
    expect(arkCalls).toBe(0);
  });
});

function reader(encoded: EncodedSnapshot): CatalogReader {
  return {
    get: (feed: FeedName) => (feed === 'popular' ? encoded : undefined),
    manifest: () => ({ schemaVersion: 1, feeds: { popular: {} } }),
    readiness: () => ({ ready: true, status: 'ok', feeds: { popular: 'ok' } }),
  };
}

function fixture(): EncodedSnapshot {
  const snapshot: CatalogSnapshot = {
    schemaVersion: 1,
    revision: '20260908T120000Z',
    feed: 'popular',
    generatedAt: '2026-09-08T12:00:00Z',
    expiresAt: '2026-09-08T14:00:00Z',
    stale: false,
    groups: { all: ['tmdb:movie:1'], movie: ['tmdb:movie:1'], tv: [], animation: [], variety: [] },
    items: {
      'tmdb:movie:1': {
        tmdbId: 1,
        mediaType: 'movie',
        category: 'movie',
        localizedTitle: '测试',
        originalTitle: 'Test',
        originalLanguage: 'en',
        originCountries: ['US'],
        aliases: [],
        releaseDate: '2026-08-01',
        sortDate: '2026-08-01',
        rating: 8,
        voteCount: 500,
        popularity: 20,
        posterPath: '',
      },
    },
  };
  const json = Buffer.from(JSON.stringify(snapshot));
  return {
    snapshot,
    json,
    gzip: gzipSync(json),
    br: brotliCompressSync(json),
    etag: '"20260908T120000Z-popular"',
  };
}
