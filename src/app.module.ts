import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { loadEnvironment } from '../packages/config/src/index.js';
import { CacheService } from '../packages/cache/src/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import { SafeSourceClient, SourceRegistry } from '../packages/source-sdk/src/index.js';
import { StormAdapter } from '../packages/sources/storm/src/storm.adapter.js';
import { SourceBAdapter } from '../packages/sources/source-b/src/source-b.adapter.js';
import {
  AdminService,
  CatalogService,
  HealthService,
  HistoryService,
  InstallationService,
  PlaybackService,
  QueueService,
  SyncService,
} from './core.js';
import {
  AdminController,
  ApiExceptionFilter,
  AppController,
  HealthController,
  MetricsController,
} from './controllers.js';

const env = loadEnvironment();
const database = createDatabase(env.DATABASE_URL);
const cache = new CacheService(env.CACHE_REDIS_URL);
const registry = new SourceRegistry();
registry.register(
  'storm',
  new StormAdapter(
    new SafeSourceClient(env.STORM_BASE_URL, {
      allowPrivate: env.SOURCE_ALLOW_PRIVATE_HOSTS,
      connectTimeoutMs: env.SOURCE_CONNECT_TIMEOUT_MS,
      headersTimeoutMs: env.SOURCE_HEADERS_TIMEOUT_MS,
    }),
    env.SOURCE_ALLOW_PRIVATE_HOSTS,
  ),
);
registry.register('source-b', new SourceBAdapter());
registry.register(
  'source-b-http',
  new StormAdapter(
    new SafeSourceClient(env.SOURCE_B_BASE_URL ?? 'https://example.com/api/vod', {
      allowPrivate: env.SOURCE_ALLOW_PRIVATE_HOSTS,
      connectTimeoutMs: env.SOURCE_CONNECT_TIMEOUT_MS,
      headersTimeoutMs: env.SOURCE_HEADERS_TIMEOUT_MS,
    }),
    env.SOURCE_ALLOW_PRIVATE_HOSTS,
  ),
);
const queue = new QueueService(env);

@Module({
  controllers: [AppController, AdminController, HealthController, MetricsController],
  providers: [
    { provide: 'ENV', useValue: env },
    { provide: 'DB', useValue: database.db },
    { provide: 'POOL', useValue: database.pool },
    { provide: 'CACHE', useValue: cache },
    { provide: 'REGISTRY', useValue: registry },
    { provide: 'QUEUE', useValue: queue },
    { provide: InstallationService, useFactory: () => new InstallationService(database.db, env) },
    { provide: CatalogService, useFactory: () => new CatalogService(database.db, cache) },
    { provide: HistoryService, useFactory: () => new HistoryService(database.db) },
    {
      provide: PlaybackService,
      useFactory: () => new PlaybackService(database.db, registry, cache, env),
    },
    { provide: SyncService, useFactory: () => new SyncService(database.db, registry, cache) },
    {
      provide: AdminService,
      useFactory: () => new AdminService(database.db, queue, cache, registry),
    },
    { provide: HealthService, useFactory: () => new HealthService(database.pool, cache) },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

export const runtime = { env, database, cache, registry, queue };
