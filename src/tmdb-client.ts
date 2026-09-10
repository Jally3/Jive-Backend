import { setTimeout as delay } from 'node:timers/promises';

export interface TmdbListItem {
  id?: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
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

  constructor(
    private readonly options: {
      token: string;
      baseUrl: string;
      concurrency: number;
      pages: number;
      timeoutMs: number;
      fetch?: typeof fetch;
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
    return this.request<TmdbListItem>(`/tv/${id}`, { language: 'zh-CN' });
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

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.semaphore.run(async () => {
      const url = new URL(`${this.options.baseUrl}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await (this.options.fetch ?? fetch)(url, {
            headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          if (response.ok) {
            const length = Number(response.headers.get('content-length') ?? 0);
            if (length > 2_000_000) throw new Error('TMDB response exceeds 2 MB');
            const text = await response.text();
            if (Buffer.byteLength(text) > 2_000_000) throw new Error('TMDB response exceeds 2 MB');
            return JSON.parse(text) as T;
          }
          if (![429, 500, 502, 503, 504].includes(response.status)) {
            throw new NonRetryableError(`TMDB returned HTTP ${response.status}`);
          }
          const retryAfter = Number(response.headers.get('retry-after') ?? 0);
          await delay(retryAfter > 0 ? Math.min(retryAfter * 1_000, 30_000) : attempt * 500);
        } catch (error) {
          if (error instanceof NonRetryableError) throw error;
          lastError = error;
          if (attempt < 3) await delay(attempt * 500 + Math.floor(Math.random() * 250));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('TMDB request failed');
    });
  }
}

class NonRetryableError extends Error {}
