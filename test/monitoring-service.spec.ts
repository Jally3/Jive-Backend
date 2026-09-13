import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger.js';
import { MonitoringService } from '../src/monitoring-service.js';

describe('MonitoringService', () => {
  it('aggregates HTTP, TMDB and refresh metrics and restores them from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-monitoring-'));
    const stateFile = join(directory, 'monitoring.json');
    let now = Date.parse('2026-09-13T12:00:00Z');
    const service = createService(stateFile, () => now);
    await service.start();

    service.recordHttp({
      route: 'catalog/popular',
      statusCode: 200,
      durationMs: 12.34,
      responseBytes: 500,
      contentEncoding: 'gzip',
    });
    service.recordTmdb({
      endpoint: 'discover/movie',
      success: true,
      attempts: 2,
      retries: 1,
      timeouts: 0,
      rateLimited: 1,
      durationMs: 800,
    });
    service.recordTmdbCache('hit');
    service.recordCatalogRefresh({
      feed: 'popular',
      success: true,
      durationMs: 2_000,
      itemCount: 100,
      jsonBytes: 1_000,
      gzipBytes: 500,
      brotliBytes: 400,
    });
    await service.flush();

    now += 1_000;
    const restored = createService(stateFile, () => now);
    await restored.start();
    const day = restored.overview(30).days[0];
    expect(day?.date).toBe('2026-09-13');
    expect(day?.metrics.http['catalog/popular']).toMatchObject({ requests: 1, responseBytes: 500 });
    expect(day?.metrics.http['catalog/popular']).toMatchObject({
      firstCalledAt: '2026-09-13T12:00:00.000Z',
      lastCalledAt: '2026-09-13T12:00:00.000Z',
    });
    expect(day?.metrics.tmdb['discover/movie']).toMatchObject({
      logicalCalls: 1,
      attempts: 2,
      retries: 1,
      rateLimited: 1,
    });
    expect(day?.metrics.catalog.popular).toMatchObject({ successes: 1, lastItemCount: 100 });
  });

  it('uses the configured timezone and prunes expired daily buckets', async () => {
    let now = Date.parse('2026-09-12T16:30:00Z');
    const service = new MonitoringService({
      logger: new Logger('error'),
      retentionDays: 2,
      timezone: 'Asia/Shanghai',
      saveIntervalMs: 60_000,
      now: () => now,
    });
    await service.start();
    service.recordTmdbCache('miss');
    expect(service.overview().days[0]?.date).toBe('2026-09-13');

    now += 3 * 86_400_000;
    service.recordTmdbCache('hit');
    expect(service.overview().days.map((day) => day.date)).toEqual(['2026-09-16']);
  });
});

function createService(stateFile: string, now: () => number): MonitoringService {
  return new MonitoringService({
    logger: new Logger('error'),
    stateFile,
    retentionDays: 90,
    timezone: 'Asia/Shanghai',
    saveIntervalMs: 3_600_000,
    now,
  });
}
