import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://jive:jive@localhost:5432/jive';
process.env.CACHE_REDIS_URL = 'redis://localhost:6379/0';
process.env.QUEUE_REDIS_URL = 'redis://localhost:6380/0';
process.env.ADMIN_AUTH_TOKEN = 'test-admin-token-at-least-32-characters';
process.env.INSTALLATION_TOKEN_SECRET = 'test-installation-secret-at-least-32';
process.env.STORM_BASE_URL = 'https://example.com/api/vod';

describe('API contract', () => {
  let app: Awaited<ReturnType<(typeof import('../../apps/api/src/main.js'))['createApp']>>;
  let runtime: (typeof import('../../src/app.module.js'))['runtime'];
  beforeAll(async () => {
    const { createApp: appFactory } = await import('../../apps/api/src/main.js');
    ({ runtime } = await import('../../src/app.module.js'));
    app = await appFactory();
  });
  afterAll(async () => {
    await app.close();
    await runtime.queue.close();
    await runtime.cache.close();
    await runtime.database.pool.end();
  });
  it('serves liveness through Fastify', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
  it('returns a uniform validation envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/installations',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      data: null,
      error: { code: 'VALIDATION_FAILED', retryable: false },
      request_id: expect.stringMatching(/^req_/),
    });
  });
});
