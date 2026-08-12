import { describe, expect, it } from 'vitest';
import { environmentSchema } from '../packages/config/src/index.js';
const valid = {
  DATABASE_URL: 'postgresql://localhost/jive',
  CACHE_REDIS_URL: 'redis://localhost:6379',
  QUEUE_REDIS_URL: 'redis://localhost:6380',
  ADMIN_AUTH_TOKEN: 'a'.repeat(32),
  INSTALLATION_TOKEN_SECRET: 'b'.repeat(32),
  STORM_BASE_URL: 'https://example.com/api',
};
describe('environment validation', () => {
  it('fails fast on weak secrets', () => {
    expect(() => environmentSchema.parse({ ...valid, ADMIN_AUTH_TOKEN: 'short' })).toThrow();
  });
  it('uses explicit operational defaults', () => {
    expect(environmentSchema.parse(valid).PLAYBACK_MAX_CANDIDATES).toBe(3);
  });
});
