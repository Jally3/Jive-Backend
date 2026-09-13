import type { Logger } from './logger.js';
import { loadMonitoringState, saveMonitoringState } from './monitoring-store.js';
import type {
  CatalogDailyMetric,
  CatalogRefreshMetricEvent,
  DurationTotals,
  HttpDailyMetric,
  HttpMetricEvent,
  MonitoringDay,
  MonitoringEvent,
  MonitoringObserver,
  PersistedMonitoringState,
  TmdbCacheResult,
  TmdbDailyMetric,
  TmdbMetricEvent,
} from './monitoring-types.js';

const MAX_RECENT_EVENTS = 100;

export class MonitoringService implements MonitoringObserver {
  private state: PersistedMonitoringState;
  private version = 0;
  private savedVersion = 0;
  private lastSavedAt = 0;
  private saving: Promise<void> | undefined;

  constructor(
    private readonly options: {
      logger: Logger;
      stateFile?: string;
      retentionDays: number;
      timezone: string;
      saveIntervalMs: number;
      now?: () => number;
    },
  ) {
    this.state = emptyState(options.timezone, this.now());
  }

  async start(): Promise<void> {
    let restoredState = false;
    try {
      const restored = await loadMonitoringState(this.options.stateFile);
      if (restored) {
        restoredState = true;
        this.state = restored;
        if (this.prune()) this.version += 1;
        this.options.logger.info('monitoring state restored', {
          days: Object.keys(restored.days).length,
        });
      }
    } catch (error) {
      this.options.logger.error('monitoring state restore failed', { error: errorMessage(error) });
      this.addEvent({
        category: 'monitoring',
        level: 'error',
        message: 'monitoring state restore failed',
        detail: errorMessage(error),
      });
      this.version += 1;
    }
    this.lastSavedAt = restoredState ? this.now() : 0;
  }

  recordHttp(event: HttpMetricEvent): void {
    const day = this.today();
    const metric = (day.http[event.route] ??= emptyHttpMetric());
    const calledAt = new Date(this.now()).toISOString();
    metric.firstCalledAt ??= calledAt;
    metric.lastCalledAt = calledAt;
    metric.requests += 1;
    increment(metric.statuses, String(event.statusCode));
    addDuration(metric.duration, event.durationMs);
    metric.responseBytes += finiteNonNegative(event.responseBytes);
    increment(metric.encodings, event.contentEncoding || 'identity');
    this.changed();
  }

  recordTmdb(event: TmdbMetricEvent): void {
    const day = this.today();
    const metric = (day.tmdb[event.endpoint] ??= emptyTmdbMetric());
    metric.logicalCalls += 1;
    metric.attempts += finiteNonNegative(event.attempts);
    metric.retries += finiteNonNegative(event.retries);
    metric.timeouts += finiteNonNegative(event.timeouts);
    metric.rateLimited += finiteNonNegative(event.rateLimited);
    if (event.success) metric.successes += 1;
    else metric.failures += 1;
    addDuration(metric.duration, event.durationMs);
    this.changed();
  }

  recordTmdbCache(result: TmdbCacheResult): void {
    const metric = this.today().tmdbCache;
    if (result === 'hit') metric.hits += 1;
    else if (result === 'miss') metric.misses += 1;
    else if (result === 'inflight_coalesced') metric.inflightCoalesced += 1;
    else if (result === 'negative_hit') metric.negativeHits += 1;
    else metric.expired += 1;
    this.changed();
  }

  recordCatalogRefresh(event: CatalogRefreshMetricEvent): void {
    const day = this.today();
    const metric = (day.catalog[event.feed] ??= emptyCatalogMetric());
    metric.attempts += 1;
    if (event.success) metric.successes += 1;
    else metric.failures += 1;
    addDuration(metric.duration, event.durationMs);
    if (event.itemCount !== undefined) metric.lastItemCount = event.itemCount;
    if (event.jsonBytes !== undefined) metric.lastJsonBytes = event.jsonBytes;
    if (event.gzipBytes !== undefined) metric.lastGzipBytes = event.gzipBytes;
    if (event.brotliBytes !== undefined) metric.lastBrotliBytes = event.brotliBytes;
    this.addEvent({
      category: 'catalog',
      level: event.success ? 'info' : 'error',
      message: event.success ? 'catalog refresh completed' : 'catalog refresh failed',
      feed: event.feed,
      ...(event.error ? { detail: event.error.slice(0, 300) } : {}),
    });
    this.changed();
  }

  overview(days = 30): {
    timezone: string;
    retentionDays: number;
    stateFile: { enabled: boolean; path?: string; lastSavedAt?: string; dirty: boolean };
    days: Array<{ date: string; metrics: MonitoringDay }>;
    recentEvents: MonitoringEvent[];
  } {
    if (this.prune()) this.version += 1;
    const limit = Math.min(Math.max(Math.trunc(days), 1), this.options.retentionDays);
    const selected = Object.entries(this.state.days)
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, limit)
      .map(([date, metrics]) => ({ date, metrics }));
    return {
      timezone: this.options.timezone,
      retentionDays: this.options.retentionDays,
      stateFile: {
        enabled: Boolean(this.options.stateFile),
        ...(this.options.stateFile ? { path: this.options.stateFile } : {}),
        ...(this.lastSavedAt ? { lastSavedAt: new Date(this.lastSavedAt).toISOString() } : {}),
        dirty: this.version !== this.savedVersion,
      },
      days: structuredClone(selected),
      recentEvents: structuredClone(this.state.recentEvents),
    };
  }

  async flush(): Promise<void> {
    if (!this.options.stateFile || this.version === this.savedVersion) return;
    if (this.saving) {
      await this.saving;
      if (this.version !== this.savedVersion) await this.flush();
      return;
    }
    if (this.prune()) this.version += 1;
    const savingVersion = this.version;
    const snapshot = structuredClone(this.state);
    snapshot.updatedAt = new Date(this.now()).toISOString();
    this.saving = saveMonitoringState(this.options.stateFile, snapshot);
    try {
      await this.saving;
      this.savedVersion = savingVersion;
      this.lastSavedAt = this.now();
    } finally {
      this.saving = undefined;
    }
  }

  async stop(): Promise<void> {
    await this.flush();
  }

  private today(): MonitoringDay {
    const key = dateKey(this.now(), this.options.timezone);
    return (this.state.days[key] ??= emptyDay());
  }

  private addEvent(event: Omit<MonitoringEvent, 'occurredAt'>): void {
    this.state.recentEvents.unshift({ occurredAt: new Date(this.now()).toISOString(), ...event });
    this.state.recentEvents.splice(MAX_RECENT_EVENTS);
  }

  private changed(): void {
    this.version += 1;
    if (
      this.options.stateFile &&
      !this.saving &&
      this.now() - this.lastSavedAt >= this.options.saveIntervalMs
    ) {
      void this.flush().catch((error) => {
        this.options.logger.error('monitoring state save failed', { error: errorMessage(error) });
      });
    }
  }

  private prune(): boolean {
    let changed = false;
    const oldest = dateKey(
      this.now() - (this.options.retentionDays - 1) * 86_400_000,
      this.options.timezone,
    );
    for (const date of Object.keys(this.state.days)) {
      if (date < oldest) {
        delete this.state.days[date];
        changed = true;
      }
    }
    return changed;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function emptyState(timezone: string, now: number): PersistedMonitoringState {
  return {
    schemaVersion: 1,
    timezone,
    updatedAt: new Date(now).toISOString(),
    days: {},
    recentEvents: [],
  };
}

function emptyDay(): MonitoringDay {
  return {
    http: {},
    tmdb: {},
    tmdbCache: { hits: 0, misses: 0, inflightCoalesced: 0, negativeHits: 0, expired: 0 },
    catalog: {},
  };
}

function emptyHttpMetric(): HttpDailyMetric {
  return { requests: 0, statuses: {}, duration: emptyDuration(), responseBytes: 0, encodings: {} };
}

function emptyTmdbMetric(): TmdbDailyMetric {
  return {
    logicalCalls: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    timeouts: 0,
    rateLimited: 0,
    duration: emptyDuration(),
  };
}

function emptyCatalogMetric(): CatalogDailyMetric {
  return { attempts: 0, successes: 0, failures: 0, duration: emptyDuration() };
}

function emptyDuration(): DurationTotals {
  return { count: 0, sumMs: 0, maxMs: 0 };
}

function addDuration(target: DurationTotals, durationMs: number): void {
  const value = Math.round(finiteNonNegative(durationMs) * 100) / 100;
  target.count += 1;
  target.sumMs = Math.round((target.sumMs + value) * 100) / 100;
  target.maxMs = Math.max(target.maxMs, value);
}

function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function dateKey(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';
