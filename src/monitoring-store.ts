import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PersistedMonitoringState, TmdbCacheDailyMetric } from './monitoring-types.js';

export async function loadMonitoringState(
  path: string | undefined,
): Promise<PersistedMonitoringState | undefined> {
  if (!path) return undefined;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as PersistedMonitoringState;
    validateMonitoringState(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveMonitoringState(
  path: string | undefined,
  state: PersistedMonitoringState,
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o640 });
  await rename(temporary, path);
}

export function validateMonitoringState(value: PersistedMonitoringState): void {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.timezone !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !value.days ||
    typeof value.days !== 'object' ||
    !Array.isArray(value.recentEvents)
  ) {
    throw new Error('invalid monitoring state');
  }
  for (const [date, day] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || typeof day !== 'object') {
      throw new Error('invalid monitoring day');
    }
    if (
      !isRecord(day.http) ||
      !isRecord(day.tmdb) ||
      !isRecord(day.tmdbCache) ||
      !isRecord(day.catalog)
    ) {
      throw new Error(`invalid monitoring metrics for ${date}`);
    }
    for (const metric of Object.values(day.http)) {
      if (
        !isRecord(metric) ||
        !counter(metric.requests) ||
        !optionalTimestamp(metric.firstCalledAt) ||
        !optionalTimestamp(metric.lastCalledAt) ||
        !isRecord(metric.statuses) ||
        !duration(metric.duration) ||
        !counter(metric.responseBytes) ||
        !isRecord(metric.encodings)
      ) {
        throw new Error(`invalid HTTP monitoring metrics for ${date}`);
      }
    }
    for (const metric of Object.values(day.tmdb)) {
      if (
        !isRecord(metric) ||
        ![
          'logicalCalls',
          'attempts',
          'successes',
          'failures',
          'retries',
          'timeouts',
          'rateLimited',
        ].every((name) => counter(metric[name])) ||
        !duration(metric.duration)
      ) {
        throw new Error(`invalid TMDB monitoring metrics for ${date}`);
      }
    }
    const cacheCounters: Array<keyof TmdbCacheDailyMetric> = [
      'hits',
      'misses',
      'inflightCoalesced',
      'negativeHits',
      'expired',
    ];
    if (!cacheCounters.every((name) => counter(day.tmdbCache[name]))) {
      throw new Error(`invalid TMDB cache metrics for ${date}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function counter(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function duration(value: unknown): boolean {
  return (
    isRecord(value) &&
    counter(value.count) &&
    counter(value.sumMs) &&
    counter(value.maxMs) &&
    (value.buckets === undefined ||
      (isRecord(value.buckets) && Object.values(value.buckets).every(counter)))
  );
}
