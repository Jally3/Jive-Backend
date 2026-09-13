import { setTimeout as delay } from 'node:timers/promises';
import type { MonitoringObserver } from './monitoring-types.js';

export interface TmdbListItem {
  id?: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  original_language?: string;
  origin_country?: string[];
  production_countries?: Array<{ iso_3166_1?: string }>;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  genres?: Array<{ id?: number }>;
  adult?: boolean;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  poster_path?: string | null;
  last_episode_to_air?: { air_date?: string; season_number?: number } | null;
  number_of_seasons?: number;
  number_of_episodes?: number;
  type?: string;
}

export interface TmdbDetailStats {
  cacheHits: number;
  upstreamSuccesses: number;
  failures: number;
  retries: number;
}

interface PageResponse {
  page?: number;
  total_pages?: number;
  results?: TmdbListItem[];
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly maximum: number) {}
  diagnostics(): { active: number; waiting: number; maximum: number } {
    return { active: this.active, waiting: this.waiters.length, maximum: this.maximum };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class TmdbClient {
  private readonly semaphore: Semaphore;
  private readonly detailCache = new Map<
    string,
    { expiresAt: number; value?: TmdbListItem; error?: Error }
  >();
  private readonly detailInflight = new Map<string, Promise<TmdbListItem>>();
  private detailStats: TmdbDetailStats = emptyDetailStats();

  constructor(
    private readonly options: {
      token: string;
      baseUrl: string;
      concurrency: number;
      pages: number;
      timeoutMs: number;
      fetch?: typeof fetch;
      monitoring?: MonitoringObserver;
    },
  ) {
    this.semaphore = new Semaphore(options.concurrency);
  }

  discoverMovies(params: Record<string, string>): Promise<TmdbListItem[]> {
    return this.pages('/discover/movie', params);
  }
  discoverTv(params: Record<string, string>): Promise<TmdbListItem[]> {
    return this.pages('/discover/tv', params);
  }
  onTheAir(): Promise<TmdbListItem[]> {
    return this.pages('/tv/on_the_air', { language: 'zh-CN' });
  }
  trending(mediaType: 'movie' | 'tv'): Promise<TmdbListItem[]> {
    return this.pages(`/trending/${mediaType}/week`, { language: 'zh-CN' });
  }
  tvDetail(id: number): Promise<TmdbListItem> {
    return this.detail('tv', id);
  }
  movieDetail(id: number): Promise<TmdbListItem> {
    return this.detail('movie', id);
  }
  consumeDetailStats(): TmdbDetailStats {
    const stats = this.detailStats;
    this.detailStats = emptyDetailStats();
    return stats;
  }
  diagnostics(): {
    detailCacheEntries: number;
    detailInflight: number;
    concurrency: { active: number; waiting: number; maximum: number };
  } {
    return {
      detailCacheEntries: this.detailCache.size,
      detailInflight: this.detailInflight.size,
      concurrency: this.semaphore.diagnostics(),
    };
  }

  private detail(mediaType: 'movie' | 'tv', id: number): Promise<TmdbListItem> {
    const key = `${mediaType}:${id}`;
    const now = Date.now();
    const cached = this.detailCache.get(key);
    if (cached && cached.expiresAt > now) {
      this.detailStats.cacheHits += 1;
      this.options.monitoring?.recordTmdbCache(cached.error ? 'negative_hit' : 'hit');
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value ?? {});
    }
    if (cached) {
      this.detailCache.delete(key);
      this.options.monitoring?.recordTmdbCache('expired');
    }
    const running = this.detailInflight.get(key);
    if (running) {
      this.detailStats.cacheHits += 1;
      this.options.monitoring?.recordTmdbCache('inflight_coalesced');
      return running;
    }
    if (!cached) this.options.monitoring?.recordTmdbCache('miss');
    const operation = this.request<TmdbListItem>(`/${mediaType}/${id}`, { language: 'zh-CN' }, true)
      .then((value) => {
        this.detailStats.upstreamSuccesses += 1;
        this.detailCache.set(key, {
          expiresAt: Date.now() + (mediaType === 'movie' ? 7 * 86_400_000 : 12 * 3_600_000),
          value,
        });
        return value;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error('TMDB detail request failed');
        this.detailStats.failures += 1;
        this.detailCache.set(key, { expiresAt: Date.now() + 30 * 60_000, error: normalized });
        throw normalized;
      })
      .finally(() => this.detailInflight.delete(key));
    this.detailInflight.set(key, operation);
    return operation;
  }

  private async pages(path: string, params: Record<string, string>): Promise<TmdbListItem[]> {
    const first = await this.request<PageResponse>(path, { ...params, page: '1' });
    const pageCount = Math.min(Math.max(first.total_pages ?? 1, 1), this.options.pages);
    const results = [...(Array.isArray(first.results) ? first.results : [])];
    const remaining = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
    const pages = await Promise.all(
      remaining.map((page) => this.request<PageResponse>(path, { ...params, page: String(page) })),
    );
    for (const response of pages) {
      if (Array.isArray(response.results)) results.push(...response.results);
    }
    return results;
  }

  private async request<T>(
    path: string,
    params: Record<string, string>,
    detailRequest = false,
  ): Promise<T> {
    const started = performance.now();
    let attempts = 0;
    let timeouts = 0;
    let rateLimited = 0;
    let success = false;
    return this.semaphore
      .run(async () => {
        const url = new URL(`${this.options.baseUrl}${path}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          attempts += 1;
          try {
            const response = await (this.options.fetch ?? fetch)(url, {
              headers: {
                Authorization: `Bearer ${this.options.token}`,
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            if (response.ok) {
              const length = Number(response.headers.get('content-length') ?? 0);
              if (length > 2_000_000) throw new Error('TMDB response exceeds 2 MB');
              const text = await response.text();
              if (Buffer.byteLength(text) > 2_000_000)
                throw new Error('TMDB response exceeds 2 MB');
              success = true;
              return JSON.parse(text) as T;
            }
            if (response.status === 429) rateLimited += 1;
            if (![429, 500, 502, 503, 504].includes(response.status)) {
              throw new NonRetryableError(`TMDB returned HTTP ${response.status}`);
            }
            lastError = new Error(`TMDB returned HTTP ${response.status}`);
            if (attempt < 3) {
              if (detailRequest) this.detailStats.retries += 1;
              const retryAfter = Number(response.headers.get('retry-after') ?? 0);
              await delay(retryAfter > 0 ? Math.min(retryAfter * 1_000, 30_000) : attempt * 500);
            }
          } catch (error) {
            if (error instanceof NonRetryableError) throw error;
            if (isTimeout(error)) timeouts += 1;
            lastError = error;
            if (attempt < 3) {
              if (detailRequest) this.detailStats.retries += 1;
              await delay(attempt * 500 + Math.floor(Math.random() * 250));
            }
          }
        }
        throw lastError instanceof Error ? lastError : new Error('TMDB request failed');
      })
      .finally(() => {
        this.options.monitoring?.recordTmdb({
          endpoint: normalizeEndpoint(path),
          success,
          attempts,
          retries: Math.max(0, attempts - 1),
          timeouts,
          rateLimited,
          durationMs: performance.now() - started,
        });
      });
  }
}

class NonRetryableError extends Error {}

function normalizeEndpoint(path: string): string {
  if (/^\/movie\/\d+$/.test(path)) return 'movie/:id';
  if (/^\/tv\/\d+$/.test(path)) return 'tv/:id';
  return path.replace(/^\//, '');
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}

const emptyDetailStats = (): TmdbDetailStats => ({
  cacheHits: 0,
  upstreamSuccesses: 0,
  failures: 0,
  retries: 0,
});
