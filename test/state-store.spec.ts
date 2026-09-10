import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, saveState } from '../src/state-store.js';
import type { CatalogSnapshot } from '../src/types.js';

describe('state store', () => {
  it('atomically saves and restores a valid snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-catalog-'));
    const path = join(directory, 'state.json');
    const snapshot = fixture();
    await saveState(path, { schemaVersion: 1, snapshots: { popular: snapshot } });
    expect(await loadState(path)).toEqual({ schemaVersion: 1, snapshots: { popular: snapshot } });
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('snapshots.popular');
  });

  it('rejects snapshots with dangling group references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-catalog-'));
    const path = join(directory, 'state.json');
    const snapshot = fixture();
    snapshot.groups.all = ['tmdb:movie:404'];
    await saveState(path, { schemaVersion: 1, snapshots: { popular: snapshot } });
    await expect(loadState(path)).rejects.toThrow('missing item');
  });
});

function fixture(): CatalogSnapshot {
  return {
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
