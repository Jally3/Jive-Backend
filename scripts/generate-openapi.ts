process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://jive:jive@localhost:5432/jive';
process.env.CACHE_REDIS_URL ??= 'redis://localhost:6379/0';
process.env.QUEUE_REDIS_URL ??= 'redis://localhost:6380/0';
process.env.ADMIN_AUTH_TOKEN ??= 'test-admin-token-at-least-32-characters';
process.env.INSTALLATION_TOKEN_SECRET ??= 'test-installation-secret-at-least-32';
process.env.STORM_BASE_URL ??= 'https://example.com/api/vod';
const { createApp } = await import('../apps/api/src/main.js');
const { runtime } = await import('../src/app.module.js');
const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
const { writeFile, readFile } = await import('node:fs/promises');
const app = await createApp();
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle('Jive Backend API').setVersion('1.0').addBearerAuth().build(),
);
const rendered = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile('openapi.json', 'utf8');
  if (existing !== rendered) {
    console.error('openapi.json is stale; run pnpm openapi:generate');
    process.exitCode = 1;
  }
} else await writeFile('openapi.json', rendered);
await app.close();
await runtime.queue.close();
await runtime.cache.close();
await runtime.database.pool.end();
