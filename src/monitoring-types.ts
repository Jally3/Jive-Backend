import type { FeedName } from './types.js';

export interface DurationTotals {
  count: number;
  sumMs: number;
  maxMs: number;
}

export interface HttpDailyMetric {
  requests: number;
  firstCalledAt?: string;
  lastCalledAt?: string;
  statuses: Record<string, number>;
  duration: DurationTotals;
  responseBytes: number;
  encodings: Record<string, number>;
}

export interface TmdbDailyMetric {
  logicalCalls: number;
  attempts: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  rateLimited: number;
  duration: DurationTotals;
}

export interface TmdbCacheDailyMetric {
  hits: number;
  misses: number;
  inflightCoalesced: number;
  negativeHits: number;
  expired: number;
}

export interface CatalogDailyMetric {
  attempts: number;
  successes: number;
  failures: number;
  duration: DurationTotals;
  lastItemCount?: number;
  lastJsonBytes?: number;
  lastGzipBytes?: number;
  lastBrotliBytes?: number;
}

export interface MonitoringDay {
  http: Record<string, HttpDailyMetric>;
  tmdb: Record<string, TmdbDailyMetric>;
  tmdbCache: TmdbCacheDailyMetric;
  catalog: Partial<Record<FeedName, CatalogDailyMetric>>;
}

export interface MonitoringEvent {
  occurredAt: string;
  category: 'catalog' | 'monitoring';
  level: 'info' | 'error';
  message: string;
  feed?: FeedName;
  detail?: string;
}

export interface PersistedMonitoringState {
  schemaVersion: 1;
  timezone: string;
  updatedAt: string;
  days: Record<string, MonitoringDay>;
  recentEvents: MonitoringEvent[];
}

export interface HttpMetricEvent {
  route: string;
  statusCode: number;
  durationMs: number;
  responseBytes: number;
  contentEncoding: string;
}

export interface TmdbMetricEvent {
  endpoint: string;
  success: boolean;
  attempts: number;
  retries: number;
  timeouts: number;
  rateLimited: number;
  durationMs: number;
}

export type TmdbCacheResult = 'hit' | 'miss' | 'inflight_coalesced' | 'negative_hit' | 'expired';

export interface CatalogRefreshMetricEvent {
  feed: FeedName;
  success: boolean;
  durationMs: number;
  itemCount?: number;
  jsonBytes?: number;
  gzipBytes?: number;
  brotliBytes?: number;
  error?: string;
}

export interface MonitoringObserver {
  recordHttp(event: HttpMetricEvent): void;
  recordTmdb(event: TmdbMetricEvent): void;
  recordTmdbCache(result: TmdbCacheResult): void;
  recordCatalogRefresh(event: CatalogRefreshMetricEvent): void;
}
