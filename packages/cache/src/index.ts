import { Redis } from 'ioredis';

export class CacheService {
  readonly redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined);
  }
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify({ schema_version: 1, value }),
        'EX',
        Math.max(1, ttlSeconds),
      );
    } catch {
      /* cache is optional */
    }
  }
  async getVersion(): Promise<number> {
    try {
      return Number(await this.redis.get('catalog:version')) || 1;
    } catch {
      return 1;
    }
  }
  async bumpVersion(): Promise<number> {
    try {
      return await this.redis.incr('catalog:version');
    } catch {
      return 1;
    }
  }
  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
