import { RecommendationError } from './types.js';

interface Bucket {
  window: number;
  count: number;
}

export class RecommendationControls {
  private readonly subjectBuckets = new Map<string, Bucket>();
  private readonly sourceBuckets = new Map<string, Bucket>();
  private active = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void }> = [];
  private cooldownUntil = 0;
  private consecutive429 = 0;

  constructor(
    private readonly options: {
      subjectRateLimitPerMinute: number;
      sourceRateLimitPerMinute: number;
      maxRateLimitSubjects: number;
      maxConcurrency: number;
      maxQueue: number;
      now?: () => number;
    },
  ) {}

  checkRateLimit(subjectHash: string, source: string): void {
    const now = this.now();
    this.prune(now);
    if (
      !consume(
        this.subjectBuckets,
        subjectHash,
        this.options.subjectRateLimitPerMinute,
        now,
        this.options.maxRateLimitSubjects,
      ) ||
      !consume(this.sourceBuckets, source, this.options.sourceRateLimitPerMinute, now, 20_000)
    ) {
      throw new RecommendationError(
        429,
        'RECOMMENDATION_RATE_LIMITED',
        '推荐请求过于频繁',
        true,
        60,
      );
    }
  }

  assertNotCoolingDown(): void {
    const remaining = Math.ceil((this.cooldownUntil - this.now()) / 1_000);
    if (remaining > 0) {
      throw new RecommendationError(
        503,
        'RECOMMENDATION_UPSTREAM_RATE_LIMITED',
        '推荐上游正在冷却',
        true,
        remaining,
      );
    }
  }

  acquire(): Promise<() => void> {
    this.assertNotCoolingDown();
    if (this.active < this.options.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.options.maxQueue) {
      throw new RecommendationError(
        503,
        'RECOMMENDATION_CAPACITY_EXCEEDED',
        '推荐服务等待队列已满',
        true,
        5,
      );
    }
    return new Promise((resolve) => this.queue.push({ resolve }));
  }

  recordUpstream429(retryAfterSeconds?: number): number {
    this.consecutive429 += 1;
    const fallback = [5, 15, 30, 60][Math.min(this.consecutive429 - 1, 3)]!;
    const delay = Math.min(60, Math.max(1, retryAfterSeconds ?? fallback));
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay * 1_000);
    return delay;
  }

  recordUpstreamSuccess(): void {
    this.consecutive429 = 0;
    this.cooldownUntil = 0;
  }

  diagnostics(): object {
    return {
      active: this.active,
      queued: this.queue.length,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((this.cooldownUntil - this.now()) / 1_000)),
      consecutive429: this.consecutive429,
    };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.resolve(this.releaseOnce());
      else this.active -= 1;
    };
  }

  private prune(now: number): void {
    const window = Math.floor(now / 60_000);
    for (const [key, bucket] of this.subjectBuckets)
      if (bucket.window < window) this.subjectBuckets.delete(key);
    for (const [key, bucket] of this.sourceBuckets)
      if (bucket.window < window) this.sourceBuckets.delete(key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function consume(
  map: Map<string, Bucket>,
  key: string,
  maximum: number,
  now: number,
  capacity: number,
): boolean {
  const window = Math.floor(now / 60_000);
  const bucket = map.get(key);
  if (!bucket || bucket.window !== window) {
    if (!bucket && map.size >= capacity) return false;
    map.set(key, { window, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= maximum;
}
