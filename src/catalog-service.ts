import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { CATALOG_POLICY, retryDelayMs } from './catalog-policy.js';
import type { Logger } from './logger.js';
import { loadState, saveState } from './state-store.js';
import { FEEDS, type CatalogSnapshot, type FeedName, type PersistedState } from './types.js';

export interface EncodedSnapshot {
  snapshot: CatalogSnapshot;
  json: Buffer;
  gzip: Buffer;
  br: Buffer;
  etag: string;
}

export interface SnapshotGenerator {
  generate(feed: FeedName, now?: Date): Promise<CatalogSnapshot>;
}

export class CatalogService {
  private readonly cache = new Map<FeedName, EncodedSnapshot>();
  private readonly active = new Map<FeedName, Promise<void>>();
  private readonly retryAfter = new Map<FeedName, number>();
  private readonly consecutiveFailures = new Map<FeedName, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly generator: SnapshotGenerator,
    private readonly logger: Logger,
    private readonly stateFile?: string,
  ) {}

  async start(): Promise<void> {
    try {
      const state = await loadState(this.stateFile);
      for (const feed of FEEDS) {
        const snapshot = state?.snapshots[feed];
        if (snapshot) this.cache.set(feed, encode(snapshot));
      }
      if (state) this.logger.info('catalog state restored', { feeds: this.cache.size });
    } catch (error) {
      this.logger.error('catalog state restore failed', { error: errorMessage(error) });
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  get(feed: FeedName, now = Date.now()): EncodedSnapshot | undefined {
    const encoded = this.cache.get(feed);
    if (!encoded) return undefined;
    const staleUntil =
      new Date(encoded.snapshot.generatedAt).getTime() + CATALOG_POLICY[feed].retainForMs;
    if (now > staleUntil) return undefined;
    const stale = now > new Date(encoded.snapshot.expiresAt).getTime();
    if (encoded.snapshot.stale === stale) return encoded;
    const updated = encode({ ...encoded.snapshot, stale });
    this.cache.set(feed, updated);
    return updated;
  }

  manifest(now = Date.now()): object {
    const feeds: Record<string, object> = {};
    for (const feed of FEEDS) {
      const value = this.get(feed, now);
      if (!value) continue;
      feeds[feed] = {
        revision: value.snapshot.revision,
        generatedAt: value.snapshot.generatedAt,
        expiresAt: value.snapshot.expiresAt,
        stale: value.snapshot.stale,
        path: feed === 'top_rated' ? 'top-rated.json' : `${feed}.json`,
      };
    }
    return { schemaVersion: 1, language: 'zh-CN', feeds };
  }

  readiness(now = Date.now()): {
    ready: boolean;
    status: 'ok' | 'degraded' | 'unavailable';
    feeds: Record<string, string>;
  } {
    const feeds: Record<string, string> = {};
    let stale = false;
    for (const feed of FEEDS) {
      const value = this.get(feed, now);
      feeds[feed] = value ? (value.snapshot.stale ? 'stale' : 'ok') : 'missing';
      stale ||= value?.snapshot.stale === true;
    }
    const ready = FEEDS.every((feed) => feeds[feed] !== 'missing');
    return { ready, status: ready ? (stale ? 'degraded' : 'ok') : 'unavailable', feeds };
  }

  refresh(feed: FeedName): Promise<void> {
    const running = this.active.get(feed);
    if (running) return running;
    const operation = this.doRefresh(feed).finally(() => this.active.delete(feed));
    this.active.set(feed, operation);
    return operation;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.active.size > 0) return;
    while (!this.stopped) {
      const now = Date.now();
      const due = FEEDS.find((feed) => {
        if ((this.retryAfter.get(feed) ?? 0) > now) return false;
        const snapshot = this.cache.get(feed)?.snapshot;
        return (
          !snapshot ||
          now >= new Date(snapshot.expiresAt).getTime() ||
          now - new Date(snapshot.generatedAt).getTime() >= CATALOG_POLICY[feed].refreshEveryMs
        );
      });
      if (!due) return;
      await this.refresh(due).catch(() => undefined);
    }
  }

  private async doRefresh(feed: FeedName): Promise<void> {
    const started = Date.now();
    this.logger.info('catalog refresh started', { feed });
    try {
      const snapshot = await this.generator.generate(feed);
      const encoded = encode(snapshot);
      if (encoded.json.byteLength > 1_048_576) throw new Error('snapshot exceeds 1 MiB');
      const next = Object.fromEntries(
        FEEDS.flatMap((name) => {
          const value = name === feed ? encoded.snapshot : this.cache.get(name)?.snapshot;
          return value ? [[name, value] as const] : [];
        }),
      ) as PersistedState['snapshots'];
      await saveState(this.stateFile, { schemaVersion: 1, snapshots: next });
      this.cache.set(feed, encoded);
      this.retryAfter.delete(feed);
      this.consecutiveFailures.delete(feed);
      this.logger.info('catalog refresh completed', {
        feed,
        revision: snapshot.revision,
        items: Object.keys(snapshot.items).length,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const failureCount = (this.consecutiveFailures.get(feed) ?? 0) + 1;
      const retryInMs = retryDelayMs(failureCount);
      this.consecutiveFailures.set(feed, failureCount);
      this.retryAfter.set(feed, Date.now() + retryInMs);
      this.logger.error('catalog refresh failed', {
        feed,
        durationMs: Date.now() - started,
        failureCount,
        retryInMs,
        error: errorMessage(error),
      });
      throw error;
    }
  }
}

function encode(snapshot: CatalogSnapshot): EncodedSnapshot {
  const json = Buffer.from(JSON.stringify(snapshot));
  return {
    snapshot,
    json,
    gzip: gzipSync(json, { level: 6 }),
    br: brotliCompressSync(json, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }),
    etag: `"${snapshot.revision}-${snapshot.feed}${snapshot.stale ? '-stale' : ''}"`,
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';
