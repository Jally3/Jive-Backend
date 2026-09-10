import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('requires only the TMDB token and supplies lightweight defaults', () => {
    const config = loadConfig({ TMDB_READ_ACCESS_TOKEN: 'secret' });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      tmdbConcurrency: 2,
      tmdbPages: 5,
      rateLimitPerMinute: 120,
    });
    expect(config).not.toHaveProperty('stateFile');
  });

  it('rejects unsafe concurrency and missing credentials', () => {
    expect(() => loadConfig({})).toThrow('TMDB_READ_ACCESS_TOKEN');
    expect(() => loadConfig({ TMDB_READ_ACCESS_TOKEN: 'secret', TMDB_CONCURRENCY: '8' })).toThrow(
      'TMDB_CONCURRENCY',
    );
  });
});
