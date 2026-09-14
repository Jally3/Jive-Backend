import { randomUUID } from 'node:crypto';
import {
  RecommendationError,
  type RecommendationCandidate,
  type RecommendationSession,
} from './types.js';

interface CacheEntry {
  candidates: RecommendationCandidate[];
  generatedAt: string;
  freshUntil: number;
  staleUntil: number;
  lastAccessedAt: number;
}

export class RecommendationMemoryStore {
  private readonly sessions = new Map<string, RecommendationSession>();
  private readonly cache = new Map<string, CacheEntry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      maxSessions: number;
      maxCacheEntries: number;
      sessionTtlMs: number;
      freshTtlMs: number;
      staleTtlMs: number;
      cleanupIntervalMs: number;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.cleanup(), this.options.cleanupIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sessions.clear();
    this.cache.clear();
  }

  createSession(
    value: Omit<
      RecommendationSession,
      | 'id'
      | 'createdAt'
      | 'expiresAt'
      | 'lastAccessedAt'
      | 'identities'
      | 'pages'
      | 'responsesByCursor'
      | 'inFlightByCursor'
    >,
  ): RecommendationSession {
    this.cleanup();
    if (this.sessions.size >= this.options.maxSessions) {
      throw new RecommendationError(
        503,
        'RECOMMENDATION_CAPACITY_EXCEEDED',
        '推荐服务当前会话已满',
        true,
        5,
      );
    }
    const now = this.now();
    const session: RecommendationSession = {
      ...value,
      id: `rec_${randomUUID()}`,
      createdAt: now,
      expiresAt: now + this.options.sessionTtlMs,
      lastAccessedAt: now,
      identities: new Set(),
      pages: [],
      responsesByCursor: new Map(),
      inFlightByCursor: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): RecommendationSession {
    const session = this.sessions.get(id);
    const now = this.now();
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(id);
      throw new RecommendationError(
        410,
        'RECOMMENDATION_CURSOR_EXPIRED',
        '推荐会话已过期，请刷新后重试',
      );
    }
    session.lastAccessedAt = now;
    return session;
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  setCache(key: string, candidates: RecommendationCandidate[], generatedAt: string): void {
    const now = this.now();
    this.cache.delete(key);
    this.cache.set(key, {
      candidates: structuredClone(candidates.slice(0, 24)),
      generatedAt,
      freshUntil: now + this.options.freshTtlMs,
      staleUntil: now + this.options.staleTtlMs,
      lastAccessedAt: now,
    });
    this.trimCache();
  }

  getCache(
    key: string,
    allowStale: boolean,
  ):
    | { candidates: RecommendationCandidate[]; generatedAt: string; state: 'fresh' | 'stale' }
    | undefined {
    const entry = this.cache.get(key);
    const now = this.now();
    if (!entry || entry.staleUntil <= now || (!allowStale && entry.freshUntil <= now)) {
      if (entry?.staleUntil && entry.staleUntil <= now) this.cache.delete(key);
      return undefined;
    }
    entry.lastAccessedAt = now;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return {
      candidates: structuredClone(entry.candidates),
      generatedAt: entry.generatedAt,
      state: entry.freshUntil > now ? 'fresh' : 'stale',
    };
  }

  diagnostics(): { sessions: number; cacheEntries: number } {
    return { sessions: this.sessions.size, cacheEntries: this.cache.size };
  }

  cleanup(): void {
    const now = this.now();
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(id);
    for (const [key, entry] of this.cache) if (entry.staleUntil <= now) this.cache.delete(key);
    this.trimCache();
  }

  private trimCache(): void {
    while (this.cache.size > this.options.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
