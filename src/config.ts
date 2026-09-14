import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  tmdbToken: string;
  tmdbBaseUrl: string;
  tmdbConcurrency: number;
  tmdbPages: number;
  requestTimeoutMs: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  stateFile?: string;
  monitoringStateFile?: string;
  monitoringRetentionDays: number;
  monitoringTimezone: string;
  monitoringSaveIntervalMs: number;
  adminEnabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  recommendationEnabled: boolean;
  recommendation?: RecommendationConfig;
}

export interface RecommendationConfig {
  arkApiKey: string;
  arkBaseUrl: string;
  arkModel: string;
  arkRequestTimeoutMs: number;
  arkMaxOutputTokens: number;
  arkMaxResponseBytes: number;
  arkTemperature: number;
  arkInputYuanPerMillionTokens: number;
  arkOutputYuanPerMillionTokens: number;
  promptVersion: string;
  cursorSecret: string;
  subjectSecret: string;
  fingerprintSecret: string;
  sessionTtlMs: number;
  maxSessions: number;
  maxCacheEntries: number;
  cacheFreshTtlMs: number;
  cacheStaleTtlMs: number;
  cleanupIntervalMs: number;
  maxConcurrency: number;
  maxQueue: number;
  subjectRateLimitPerMinute: number;
  sourceRateLimitPerMinute: number;
  subjectDailyCalls: number;
  subjectDailyTokens: number;
  globalDailyCalls: number;
  globalDailyTokens: number;
  globalDailyCostYuan: number;
  budgetTimezone: string;
  budgetStateFile: string;
  minItemsForNextPage: number;
}

const integer = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
};

const boolean = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

const decimal = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when RECOMMENDATION_ENABLED=true`);
  return value;
};

const requiredPositiveDecimal = (env: NodeJS.ProcessEnv, name: string): number => {
  const value = Number(required(env, name));
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new Error(`${name} must be greater than 0 and no more than 100000`);
  }
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tmdbToken = env.TMDB_READ_ACCESS_TOKEN?.trim();
  if (!tmdbToken) throw new Error('TMDB_READ_ACCESS_TOKEN is required');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, or error');
  }
  const stateFile = env.CATALOG_STATE_FILE?.trim();
  const monitoringStateFile = env.MONITORING_STATE_FILE?.trim();
  const monitoringTimezone = env.MONITORING_TIMEZONE?.trim() || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: monitoringTimezone }).format();
  } catch {
    throw new Error('MONITORING_TIMEZONE must be a valid IANA timezone');
  }
  const recommendationEnabled = boolean(env, 'RECOMMENDATION_ENABLED', false);
  let recommendation: RecommendationConfig | undefined;
  if (recommendationEnabled) {
    const budgetTimezone = env.RECOMMENDATION_BUDGET_TIMEZONE?.trim() || 'Asia/Shanghai';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: budgetTimezone }).format();
    } catch {
      throw new Error('RECOMMENDATION_BUDGET_TIMEZONE must be a valid IANA timezone');
    }
    const cursorSecret = required(env, 'RECOMMENDATION_CURSOR_SECRET');
    const subjectSecret = required(env, 'RECOMMENDATION_SUBJECT_SECRET');
    const fingerprintSecret = required(env, 'RECOMMENDATION_FINGERPRINT_SECRET');
    for (const [name, secret] of Object.entries({
      RECOMMENDATION_CURSOR_SECRET: cursorSecret,
      RECOMMENDATION_SUBJECT_SECRET: subjectSecret,
      RECOMMENDATION_FINGERPRINT_SECRET: fingerprintSecret,
    })) {
      if (Buffer.byteLength(secret) < 32) throw new Error(`${name} must contain at least 32 bytes`);
    }
    recommendation = {
      arkApiKey: required(env, 'ARK_API_KEY'),
      arkBaseUrl: required(env, 'ARK_BASE_URL').replace(/\/$/, ''),
      arkModel: required(env, 'ARK_MODEL'),
      arkRequestTimeoutMs: integer(env, 'ARK_REQUEST_TIMEOUT_MS', 18_000, 1_000, 30_000),
      arkMaxOutputTokens: integer(env, 'ARK_MAX_OUTPUT_TOKENS', 4_096, 256, 32_768),
      arkMaxResponseBytes: integer(
        env,
        'ARK_MAX_RESPONSE_BYTES',
        256 * 1_024,
        1_024,
        2 * 1_024 * 1_024,
      ),
      arkTemperature: decimal(env, 'ARK_TEMPERATURE', 0.4, 0, 2),
      arkInputYuanPerMillionTokens: requiredPositiveDecimal(
        env,
        'ARK_INPUT_YUAN_PER_MILLION_TOKENS',
      ),
      arkOutputYuanPerMillionTokens: requiredPositiveDecimal(
        env,
        'ARK_OUTPUT_YUAN_PER_MILLION_TOKENS',
      ),
      promptVersion: env.RECOMMENDATION_PROMPT_VERSION?.trim() || 'v1',
      cursorSecret,
      subjectSecret,
      fingerprintSecret,
      sessionTtlMs: integer(
        env,
        'RECOMMENDATION_SESSION_TTL_MS',
        30 * 60_000,
        60_000,
        24 * 60 * 60_000,
      ),
      maxSessions: integer(env, 'RECOMMENDATION_MAX_SESSIONS', 1_000, 1, 20_000),
      maxCacheEntries: integer(env, 'RECOMMENDATION_MAX_CACHE_ENTRIES', 500, 1, 10_000),
      cacheFreshTtlMs: integer(
        env,
        'RECOMMENDATION_CACHE_FRESH_TTL_MS',
        30 * 60_000,
        1_000,
        24 * 60 * 60_000,
      ),
      cacheStaleTtlMs: integer(
        env,
        'RECOMMENDATION_CACHE_STALE_TTL_MS',
        24 * 60 * 60_000,
        60_000,
        7 * 24 * 60 * 60_000,
      ),
      cleanupIntervalMs: integer(
        env,
        'RECOMMENDATION_CLEANUP_INTERVAL_MS',
        60_000,
        1_000,
        60 * 60_000,
      ),
      maxConcurrency: integer(env, 'RECOMMENDATION_MAX_CONCURRENCY', 4, 1, 64),
      maxQueue: integer(env, 'RECOMMENDATION_MAX_QUEUE', 16, 0, 1_000),
      subjectRateLimitPerMinute: integer(
        env,
        'RECOMMENDATION_SUBJECT_RATE_LIMIT_PER_MINUTE',
        2,
        1,
        1_000,
      ),
      sourceRateLimitPerMinute: integer(
        env,
        'RECOMMENDATION_SOURCE_RATE_LIMIT_PER_MINUTE',
        30,
        1,
        10_000,
      ),
      subjectDailyCalls: integer(env, 'RECOMMENDATION_SUBJECT_DAILY_CALLS', 12, 1, 10_000),
      subjectDailyTokens: integer(
        env,
        'RECOMMENDATION_SUBJECT_DAILY_TOKENS',
        100_000,
        1_000,
        1_000_000_000,
      ),
      globalDailyCalls: integer(env, 'RECOMMENDATION_GLOBAL_DAILY_CALLS', 500, 1, 1_000_000),
      globalDailyTokens: integer(
        env,
        'RECOMMENDATION_GLOBAL_DAILY_TOKENS',
        5_000_000,
        1_000,
        2_000_000_000,
      ),
      globalDailyCostYuan: decimal(
        env,
        'RECOMMENDATION_GLOBAL_DAILY_COST_YUAN',
        50,
        0.01,
        1_000_000,
      ),
      budgetTimezone,
      budgetStateFile: resolve(required(env, 'RECOMMENDATION_BUDGET_STATE_FILE')),
      minItemsForNextPage: integer(env, 'RECOMMENDATION_MIN_ITEMS_FOR_NEXT_PAGE', 4, 1, 24),
    };
  }
  return {
    port: integer(env, 'PORT', 3000, 1, 65_535),
    host: env.HOST?.trim() || '127.0.0.1',
    tmdbToken,
    tmdbBaseUrl: (env.TMDB_API_BASE_URL?.trim() || 'https://api.themoviedb.org/3').replace(
      /\/$/,
      '',
    ),
    tmdbConcurrency: integer(env, 'TMDB_CONCURRENCY', 4, 1, 4),
    tmdbPages: integer(env, 'TMDB_PAGES', 5, 1, 10),
    requestTimeoutMs: integer(env, 'TMDB_REQUEST_TIMEOUT_MS', 10_000, 1_000, 30_000),
    rateLimitPerMinute: integer(env, 'PUBLIC_RATE_LIMIT_MAX', 120, 1, 10_000),
    trustProxy: boolean(env, 'TRUST_PROXY', false),
    ...(stateFile ? { stateFile: resolve(stateFile) } : {}),
    ...(monitoringStateFile ? { monitoringStateFile: resolve(monitoringStateFile) } : {}),
    monitoringRetentionDays: integer(env, 'MONITORING_RETENTION_DAYS', 90, 1, 365),
    monitoringTimezone,
    monitoringSaveIntervalMs: integer(env, 'MONITORING_SAVE_INTERVAL_MS', 60_000, 1_000, 3_600_000),
    adminEnabled: boolean(env, 'ADMIN_ENABLED', false),
    logLevel: logLevel as Config['logLevel'],
    recommendationEnabled,
    ...(recommendation ? { recommendation } : {}),
  };
}
