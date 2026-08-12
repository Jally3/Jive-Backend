import { z } from 'zod';

const bool = z
  .string()
  .default('false')
  .transform((value) => value === 'true');
const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  CACHE_REDIS_URL: z.string().url(),
  QUEUE_REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  ADMIN_AUTH_TOKEN: z.string().min(32),
  INSTALLATION_TOKEN_SECRET: z.string().min(32),
  STORM_BASE_URL: z.string().url(),
  SOURCE_B_BASE_URL: z.string().url().optional(),
  SOURCE_ALLOW_PRIVATE_HOSTS: bool,
  SOURCE_CONNECT_TIMEOUT_MS: int(2000),
  SOURCE_HEADERS_TIMEOUT_MS: int(3000),
  PLAYBACK_TIMEOUT_MS: int(5000),
  PLAYBACK_CACHE_TTL_SECONDS: int(120),
  PLAYBACK_MAX_CANDIDATES: z.coerce.number().int().min(1).max(3).default(3),
  PUBLIC_RATE_LIMIT_MAX: int(120),
  SEARCH_RATE_LIMIT_MAX: int(30),
  PLAYBACK_RATE_LIMIT_MAX: int(10),
  ADMIN_RATE_LIMIT_MAX: int(30),
});

export type Environment = z.infer<typeof environmentSchema>;

let cached: Environment | undefined;
export function loadEnvironment(input: NodeJS.ProcessEnv = process.env): Environment {
  cached ??= environmentSchema.parse(input);
  return cached;
}

export function resetEnvironmentForTest(): void {
  cached = undefined;
}
