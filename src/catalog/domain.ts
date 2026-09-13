import type { TmdbDetailStats, TmdbListItem } from '../tmdb-client.js';
import type { CatalogItem, FeedName } from '../types.js';

export const DAY = 86_400_000;
export const YEAR = 365.2425 * DAY;
export const GROUPS = ['all', 'movie', 'tv', 'animation', 'variety'] as const;
export const VARIETY_GENRES = [10763, 10764, 10767] as const;
export const VARIETY_GENRE_SET = new Set<number>(VARIETY_GENRES);
export const VARIETY_LANGUAGES = ['zh', 'ja', 'ko'] as const;
export const VARIETY_LANGUAGE_ALLOWLIST = new Set<string>(VARIETY_LANGUAGES);
export const CHINESE_LANGUAGES = new Set(['zh', 'cn']);
export const CHINESE_COUNTRIES = new Set(['CN', 'HK', 'TW', 'MO']);
export const TOP_RATED_MIN_VOTES = 200;
export const TOP_RATED_VARIETY_MIN_VOTES = 20;

export const LATEST_POLICY = {
  freshWindowDays: 180,
  returningRecentDays: 14,
  minimumPopularity: 10,
  windowSize: 20,
  freshTargetPerWindow: 14,
  returningMaxPerWindow: 6,
  foreignReturningAnimationMaxPerWindow: 1,
  minimumAllItems: 20,
} as const;

export type LanguageClass = 'chinese' | 'foreign' | 'unknown';
export type CandidateKind = 'fresh' | 'returning' | 'standard';
export type GroupName = (typeof GROUPS)[number];

export interface CatalogCandidate extends CatalogItem {
  genreIds: number[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  seriesType: string;
  candidateKind: CandidateKind;
  languageClass: LanguageClass;
}

export type CandidateGroups = Record<GroupName, CatalogCandidate[]>;

export interface CatalogGenerationReport {
  feed: FeedName;
  rawCandidates: number;
  freshItems: number;
  returningItems: number;
  excludedSoap: number;
  excludedVeryLong: number;
  excludedHighFrequency: number;
  excludedVarietyLanguage: number;
  unknownMetadata: number;
  chineseItems: number;
  foreignItems: number;
  unknownLanguageItems: number;
  detailCacheHits: number;
  detailUpstreamSuccesses: number;
  detailFailures: number;
  detailRetries: number;
  finalItems: number;
  excludedSamples: Array<Record<string, unknown>>;
  metadataWarnings: Array<Record<string, unknown>>;
}

export interface CatalogUpstream {
  discoverMovies(params: Record<string, string>): Promise<TmdbListItem[]>;
  discoverTv(params: Record<string, string>): Promise<TmdbListItem[]>;
  onTheAir(): Promise<TmdbListItem[]>;
  trending(mediaType: 'movie' | 'tv'): Promise<TmdbListItem[]>;
  tvDetail(id: number): Promise<TmdbListItem>;
  movieDetail(id: number): Promise<TmdbListItem>;
  consumeDetailStats?(): TmdbDetailStats;
}
