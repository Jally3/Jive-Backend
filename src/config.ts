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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tmdbToken = env.TMDB_READ_ACCESS_TOKEN?.trim();
  if (!tmdbToken) throw new Error('TMDB_READ_ACCESS_TOKEN is required');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, or error');
  }
  const stateFile = env.CATALOG_STATE_FILE?.trim();
  return {
    port: integer(env, 'PORT', 3000, 1, 65_535),
    host: env.HOST?.trim() || '127.0.0.1',
    tmdbToken,
    tmdbBaseUrl: (env.TMDB_API_BASE_URL?.trim() || 'https://api.themoviedb.org/3').replace(
      /\/$/,
      '',
    ),
    tmdbConcurrency: integer(env, 'TMDB_CONCURRENCY', 2, 1, 4),
    tmdbPages: integer(env, 'TMDB_PAGES', 5, 1, 10),
    requestTimeoutMs: integer(env, 'TMDB_REQUEST_TIMEOUT_MS', 10_000, 1_000, 30_000),
    rateLimitPerMinute: integer(env, 'PUBLIC_RATE_LIMIT_MAX', 120, 1, 10_000),
    trustProxy: boolean(env, 'TRUST_PROXY', false),
    ...(stateFile ? { stateFile: resolve(stateFile) } : {}),
    logLevel: logLevel as Config['logLevel'],
  };
}
