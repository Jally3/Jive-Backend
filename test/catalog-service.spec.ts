import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogService, type SnapshotGenerator } from '../src/catalog-service.js';
import { Logger } from '../src/logger.js';
import type { CatalogSnapshot, FeedName } from '../src/types.js';

describe('CatalogService', () => {
  it('persists successful refreshes, restores them and marks expired data stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-catalog-service-'));
    const stateFile = join(directory, 'state.json');
    const generator: SnapshotGenerator = {
      generate: (feed) => Promise.resolve(fixture(feed)),
    };
    const service = new CatalogService(generator, new Logger('error'), stateFile);
    await service.refresh('popular');
    expect(service.get('popular', Date.parse('2026-09-08T13:00:00Z'))?.snapshot.stale).toBe(false);
    expect(service.get('popular', Date.parse('2026-09-08T15:00:00Z'))?.snapshot.stale).toBe(true);

    const restored = new CatalogService(generator, new Logger('error'), stateFile);
    await restored.start();
    restored.stop();
    expect(restored.get('popular', Date.parse('2026-09-08T15:00:00Z'))?.snapshot.revision).toBe(
      '20260908T120000Z',
    );
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    let fail = false;
    const generator: SnapshotGenerator = {
      generate: (feed) =>
        fail ? Promise.reject(new Error('upstream down')) : Promise.resolve(fixture(feed)),
    };
    const service = new CatalogService(generator, new Logger('error'));
    await service.refresh('latest');
    const revision = service.get('latest', Date.parse('2026-09-08T13:00:00Z'))?.snapshot.revision;
    fail = true;
    await expect(service.refresh('latest')).rejects.toThrow('upstream down');
    expect(service.get('latest', Date.parse('2026-09-08T13:00:00Z'))?.snapshot.revision).toBe(
      revision,
    );
  });

  it('increases retry delays after consecutive failures and resets after success', async () => {
    let fail = true;
    const logger = new CapturingLogger();
    const generator: SnapshotGenerator = {
      generate: (feed) =>
        fail ? Promise.reject(new Error('upstream down')) : Promise.resolve(fixture(feed)),
    };
    const service = new CatalogService(generator, logger);

    for (const expected of [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]) {
      await expect(service.refresh('popular')).rejects.toThrow('upstream down');
      expect(logger.errors.at(-1)).toMatchObject({ retryInMs: expected });
    }

    fail = false;
    await service.refresh('popular');
    fail = true;
    await expect(service.refresh('popular')).rejects.toThrow('upstream down');
    expect(logger.errors.at(-1)).toMatchObject({ failureCount: 1, retryInMs: 5 * 60_000 });
  });
});

class CapturingLogger extends Logger {
  readonly errors: Array<Record<string, unknown>> = [];

  constructor() {
    super('error');
  }

  override error(_message: string, fields: Record<string, unknown> = {}): void {
    this.errors.push(fields);
  }
}

function fixture(feed: FeedName): CatalogSnapshot {
  return {
    schemaVersion: 1,
    revision: '20260908T120000Z',
    feed,
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
}
