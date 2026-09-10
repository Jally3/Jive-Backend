import type { TmdbListItem } from './tmdb-client.js';
import { CATALOG_POLICY } from './catalog-policy.js';
import {
  itemId,
  type CatalogItem,
  type CatalogSnapshot,
  type Category,
  type FeedName,
  type MediaType,
} from './types.js';

const DAY = 86_400_000;
export class CatalogGenerator {
  constructor(private readonly tmdb: CatalogUpstream) {}

  async generate(feed: FeedName, now = new Date()): Promise<CatalogSnapshot> {
    const items =
      feed === 'latest'
        ? await this.latest(now)
        : feed === 'popular'
          ? await this.popular()
          : await this.topRated();
    return buildSnapshot(feed, items, now);
  }

  private async latest(now: Date): Promise<CatalogItem[]> {
    const today = dateOnly(now);
    const cutoff = dateOnly(new Date(now.getTime() - 180 * DAY));
    const [movies, newTv, onAir] = await Promise.all([
      this.tmdb.discoverMovies({
        sort_by: 'popularity.desc',
        'primary_release_date.gte': cutoff,
        'primary_release_date.lte': today,
        include_adult: 'false',
        include_video: 'false',
        language: 'zh-CN',
      }),
      this.tmdb.discoverTv({
        sort_by: 'popularity.desc',
        'first_air_date.gte': cutoff,
        'first_air_date.lte': today,
        include_adult: 'false',
        language: 'zh-CN',
      }),
      this.tmdb.onTheAir(),
    ]);

    const recentMovies = movies
      .map((item) => normalize(item, 'movie', item.release_date ?? ''))
      .filter(present)
      .filter((item) => item.popularity >= 10 && validPastDate(item.sortDate, today));
    const recentTv = newTv
      .map((item) => normalize(item, 'tv', item.first_air_date ?? ''))
      .filter(present)
      .filter((item) => item.popularity >= 10 && validPastDate(item.sortDate, today));

    const newTvIds = new Set(
      newTv.filter((item) => positiveInteger(item.id)).map((item) => item.id),
    );
    const detailIds = unique(
      onAir
        .filter(
          (item) =>
            positiveInteger(item.id) &&
            !newTvIds.has(item.id) &&
            (!safeDate(item.first_air_date) || safeDate(item.first_air_date) < cutoff),
        )
        .map((item) => item.id as number),
    );
    const details = await Promise.all(detailIds.map((id) => this.tmdb.tvDetail(id)));
    const returningTv = details
      .map((detail) => {
        const episode = detail.last_episode_to_air;
        const item = normalize(detail, 'tv', episode?.air_date ?? '');
        if (item && positiveInteger(episode?.season_number)) {
          item.latestSeasonNumber = episode?.season_number;
        }
        return item;
      })
      .filter(present)
      .filter(
        (item) =>
          item.popularity >= 10 && validPastDate(item.sortDate, today) && item.sortDate >= cutoff,
      );
    return dedupe([...recentMovies, ...recentTv, ...returningTv], newestFirst);
  }

  private async popular(): Promise<CatalogItem[]> {
    const [movies, tv] = await Promise.all([this.tmdb.trending('movie'), this.tmdb.trending('tv')]);
    return dedupe(
      [
        ...movies.map((item) => normalize(item, 'movie', item.release_date ?? '')),
        ...tv.map((item) => normalize(item, 'tv', item.first_air_date ?? '')),
      ].filter(present),
      (left, right) => right.popularity - left.popularity,
    );
  }

  private async topRated(): Promise<CatalogItem[]> {
    const params = {
      sort_by: 'vote_average.desc',
      'vote_average.gte': '7.0',
      'vote_count.gte': '200',
      include_adult: 'false',
      language: 'zh-CN',
    };
    const [movies, tv] = await Promise.all([
      this.tmdb.discoverMovies(params),
      this.tmdb.discoverTv(params),
    ]);
    return dedupe(
      [
        ...movies.map((item) => normalize(item, 'movie', item.release_date ?? '')),
        ...tv.map((item) => normalize(item, 'tv', item.first_air_date ?? '')),
      ]
        .filter(present)
        .filter((item) => item.rating >= 7 && item.voteCount >= 200),
      (left, right) => right.rating - left.rating || right.voteCount - left.voteCount,
    );
  }
}

export interface CatalogUpstream {
  discoverMovies(params: Record<string, string>): Promise<TmdbListItem[]>;
  discoverTv(params: Record<string, string>): Promise<TmdbListItem[]>;
  onTheAir(): Promise<TmdbListItem[]>;
  trending(mediaType: 'movie' | 'tv'): Promise<TmdbListItem[]>;
  tvDetail(id: number): Promise<TmdbListItem>;
}

function normalize(raw: TmdbListItem, mediaType: MediaType, sortDate: string): CatalogItem | null {
  if (!positiveInteger(raw.id) || raw.adult === true) return null;
  const localizedTitle = clean(mediaType === 'movie' ? raw.title : raw.name);
  const originalTitle = clean(mediaType === 'movie' ? raw.original_title : raw.original_name);
  if (!localizedTitle && !originalTitle) return null;
  const genres = (raw.genre_ids ?? raw.genres?.map((genre) => genre.id ?? 0) ?? []).filter(
    positiveInteger,
  );
  return {
    tmdbId: raw.id,
    mediaType,
    category: category(mediaType, genres),
    localizedTitle: localizedTitle || originalTitle,
    originalTitle,
    aliases: [],
    releaseDate: safeDate(mediaType === 'movie' ? raw.release_date : raw.first_air_date),
    sortDate: safeDate(sortDate),
    rating: finite(raw.vote_average),
    voteCount: Math.max(0, Math.trunc(finite(raw.vote_count))),
    popularity: Math.max(0, finite(raw.popularity)),
    posterPath: typeof raw.poster_path === 'string' ? raw.poster_path : '',
  };
}

function buildSnapshot(feed: FeedName, candidates: CatalogItem[], now: Date): CatalogSnapshot {
  const groups: CatalogSnapshot['groups'] = {
    all: [],
    movie: [],
    tv: [],
    animation: [],
    variety: [],
  };
  const selected = new Map<string, CatalogItem>();
  for (const item of candidates) {
    const id = itemId(item);
    if (groups.all.length < 200) groups.all.push(id);
    if (groups[item.category].length < 200) groups[item.category].push(id);
    if (groups.all.includes(id) || groups[item.category].includes(id)) selected.set(id, item);
  }
  if (groups.all.length === 0) throw new Error(`${feed} generated an empty all group`);
  const generatedAt = now.toISOString();
  return {
    schemaVersion: 1,
    revision: revision(now),
    feed,
    generatedAt,
    expiresAt: new Date(now.getTime() + CATALOG_POLICY[feed].freshForMs).toISOString(),
    stale: false,
    groups,
    items: Object.fromEntries(selected),
  };
}

function category(mediaType: MediaType, genres: number[]): Category {
  if (genres.includes(16)) return 'animation';
  if (mediaType === 'tv' && genres.some((genre) => [10763, 10764, 10767].includes(genre))) {
    return 'variety';
  }
  return mediaType;
}

function dedupe(items: CatalogItem[], compare: (a: CatalogItem, b: CatalogItem) => number) {
  const values = new Map<string, CatalogItem>();
  for (const item of items) {
    const id = itemId(item);
    const existing = values.get(id);
    if (!existing || compare(item, existing) < 0) values.set(id, item);
  }
  return [...values.values()].sort(compare);
}

const newestFirst = (left: CatalogItem, right: CatalogItem) =>
  right.sortDate.localeCompare(left.sortDate) || right.popularity - left.popularity;
const present = <T>(value: T | null): value is T => value !== null;
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const safeDate = (value: unknown): string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
const validPastDate = (value: string, today: string): boolean => value !== '' && value <= today;
const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
const revision = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
