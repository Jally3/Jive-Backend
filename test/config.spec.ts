import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('requires only the TMDB token and supplies lightweight defaults', () => {
    const config = loadConfig({ TMDB_READ_ACCESS_TOKEN: 'secret' });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      tmdbConcurrency: 4,
      tmdbPages: 5,
      rateLimitPerMinute: 120,
      monitoringRetentionDays: 90,
      monitoringTimezone: 'Asia/Shanghai',
      monitoringSaveIntervalMs: 60_000,
      adminEnabled: false,
    });
    expect(config).not.toHaveProperty('stateFile');
    expect(config).not.toHaveProperty('monitoringStateFile');
  });

  it('rejects unsafe concurrency and missing credentials', () => {
    expect(() => loadConfig({})).toThrow('TMDB_READ_ACCESS_TOKEN');
    expect(() => loadConfig({ TMDB_READ_ACCESS_TOKEN: 'secret', TMDB_CONCURRENCY: '8' })).toThrow(
      'TMDB_CONCURRENCY',
    );
  });

  it('loads and validates monitoring settings', () => {
    const config = loadConfig({
      TMDB_READ_ACCESS_TOKEN: 'secret',
      ADMIN_ENABLED: 'true',
      MONITORING_STATE_FILE: './monitoring.json',
      MONITORING_RETENTION_DAYS: '30',
      MONITORING_TIMEZONE: 'UTC',
    });
    expect(config).toMatchObject({
      adminEnabled: true,
      monitoringRetentionDays: 30,
      monitoringTimezone: 'UTC',
    });
    expect(config.monitoringStateFile).toMatch(/monitoring\.json$/);
    expect(() =>
      loadConfig({ TMDB_READ_ACCESS_TOKEN: 'secret', MONITORING_TIMEZONE: 'Mars/Olympus' }),
    ).toThrow('MONITORING_TIMEZONE');
  });
});
