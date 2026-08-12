import 'reflect-metadata';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createId } from '../../../packages/contracts/src/index.js';
import {
  httpDuration,
  httpRequests,
  startTelemetry,
} from '../../../packages/observability/src/index.js';
import { AppModule, runtime } from '../../../src/app.module.js';

export async function createApp() {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    genReqId: () => createId('req'),
    logger: {
      level: runtime.env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.token',
          '*.playback_url',
          '*.vod_play_url',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  await app.register(helmet);
  await app.register(rateLimit, {
    redis: runtime.cache.redis,
    skipOnError: true,
    max: (request) => {
      const url = request.url;
      if (url.includes('/admin/')) return runtime.env.ADMIN_RATE_LIMIT_MAX;
      if (url.includes('/playback') || url.includes('/playback-events'))
        return runtime.env.PLAYBACK_RATE_LIMIT_MAX;
      if (url.includes('/search')) return runtime.env.SEARCH_RATE_LIMIT_MAX;
      return runtime.env.PUBLIC_RATE_LIMIT_MAX;
    },
    timeWindow: '1 minute',
    keyGenerator: (request) => `${request.ip}:${request.headers['x-device-id'] ?? ''}`,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: '请求过于频繁',
    }),
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request: any, _reply: any, done: () => void) => {
    request.requestId = request.id;
    request.startedAt = process.hrtime.bigint();
    done();
  });
  fastify.addHook('onResponse', (request: any, reply: any, done: () => void) => {
    const route = request.routeOptions?.url ?? 'unknown';
    httpRequests.inc({ method: request.method, route, status: String(reply.statusCode) });
    httpDuration.observe(
      { method: request.method, route },
      Number(process.hrtime.bigint() - request.startedAt) / 1e9,
    );
    done();
  });
  const config = new DocumentBuilder()
    .setTitle('Jive Backend API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'openapi.json',
  });
  await app.init();
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const stopTelemetry = await startTelemetry(runtime.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const app = await createApp();
  await app.listen(runtime.env.PORT, '0.0.0.0');
  const shutdown = async () => {
    await app.close();
    await runtime.queue.close();
    await runtime.cache.close();
    await runtime.database.pool.end();
    await stopTelemetry?.();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
