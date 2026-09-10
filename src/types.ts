export const FEEDS = ['latest', 'popular', 'top_rated'] as const;
export type FeedName = (typeof FEEDS)[number];
export type MediaType = 'movie' | 'tv';
export type Category = 'movie' | 'tv' | 'animation' | 'variety';

export interface CatalogItem {
  tmdbId: number;
  mediaType: MediaType;
  category: Category;
  localizedTitle: string;
  originalTitle: string;
  aliases: string[];
  releaseDate: string;
  sortDate: string;
  latestSeasonNumber?: number;
  rating: number;
  voteCount: number;
  popularity: number;
  posterPath: string;
}

export interface CatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  feed: FeedName;
  generatedAt: string;
  expiresAt: string;
  stale: boolean;
  groups: Record<'all' | Category, string[]>;
  items: Record<string, CatalogItem>;
}

export interface PersistedState {
  schemaVersion: 1;
  snapshots: Partial<Record<FeedName, CatalogSnapshot>>;
}

export const isFeedName = (value: string | null): value is FeedName =>
  FEEDS.includes(value as FeedName);

export const itemId = (item: Pick<CatalogItem, 'mediaType' | 'tmdbId'>): string =>
  `tmdb:${item.mediaType}:${item.tmdbId}`;
