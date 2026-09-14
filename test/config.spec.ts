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

  it('requires complete recommendation secrets, pricing and budget persistence', () => {
    const recommendationEnv = {
      TMDB_READ_ACCESS_TOKEN: 'secret',
      RECOMMENDATION_ENABLED: 'true',
      ARK_API_KEY: 'ark-secret',
      ARK_BASE_URL: 'https://ark.example/api/v3',
      ARK_MODEL: 'ep-test',
      ARK_INPUT_YUAN_PER_MILLION_TOKENS: '1',
      ARK_OUTPUT_YUAN_PER_MILLION_TOKENS: '2',
      RECOMMENDATION_CURSOR_SECRET: '0123456789abcdef0123456789abcdef',
      RECOMMENDATION_SUBJECT_SECRET: '1123456789abcdef0123456789abcdef',
      RECOMMENDATION_FINGERPRINT_SECRET: '2123456789abcdef0123456789abcdef',
      RECOMMENDATION_BUDGET_STATE_FILE: './recommendation-budget.json',
    };
    expect(loadConfig(recommendationEnv).recommendation).toMatchObject({
      maxSessions: 1_000,
      maxCacheEntries: 500,
      maxConcurrency: 4,
      maxQueue: 16,
      subjectDailyCalls: 12,
      globalDailyCostYuan: 50,
    });
    expect(() =>
      loadConfig({ ...recommendationEnv, ARK_INPUT_YUAN_PER_MILLION_TOKENS: '0' }),
    ).toThrow('ARK_INPUT_YUAN_PER_MILLION_TOKENS');
  });
});
