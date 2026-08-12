import 'reflect-metadata';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { runtime } from '../../../src/app.module.js';
import { SyncService } from '../../../src/core.js';
import type { SyncJob } from '../../../src/core.js';
import { vodSources } from '../../../packages/database/src/schema.js';

const sync = new SyncService(runtime.database.db, runtime.registry, runtime.cache);
const connection = new Redis(runtime.env.QUEUE_REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', () => undefined);
const workers: Worker[] = [];
const healthQueue = new Queue('vod-health', { connection });
await healthQueue.add(
  'source.health-check',
  {},
  {
    jobId: 'scheduled-health',
    repeat: { every: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
);
for (const source of await runtime.database.db
  .select()
  .from(vodSources)
  .where(eq(vodSources.enabled, true)))
  workers.push(
    new Worker(`vod-sync:${source.code}`, async (job) => sync.run(job.data as SyncJob), {
      connection,
      concurrency: 2,
      limiter: { max: 5, duration: 1000 },
      lockDuration: 60_000,
    }),
  );
const healthWorker = new Worker(
  'vod-health',
  async () => {
    for (const source of await runtime.database.db
      .select()
      .from(vodSources)
      .where(eq(vodSources.enabled, true))) {
      const result = await runtime.registry
        .get(source.adapterName)
        .healthCheck({ requestId: `health-${Date.now()}` });
      await runtime.database.db
        .update(vodSources)
        .set({
          healthStatus: result.healthy
            ? 'healthy'
            : source.healthStatus === 'unknown'
              ? 'degraded'
              : 'offline',
          lastHealthAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(vodSources.id, source.id));
    }
  },
  { connection, concurrency: 1 },
);
workers.push(healthWorker);
const shutdown = async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await healthQueue.close();
  connection.disconnect();
  await runtime.queue.close();
  await runtime.cache.close();
  await runtime.database.pool.end();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
