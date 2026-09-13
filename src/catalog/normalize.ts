import type { TmdbListItem } from '../tmdb-client.js';
import type { Category, MediaType } from '../types.js';
import {
  CHINESE_COUNTRIES,
  CHINESE_LANGUAGES,
  VARIETY_GENRE_SET,
  type CandidateKind,
  type CatalogCandidate,
  type LanguageClass,
} from './domain.js';

export function normalize(
  raw: TmdbListItem,
  mediaType: MediaType,
  sortDate: string,
  candidateKind: CandidateKind,
): CatalogCandidate | null {
  if (!positiveInteger(raw.id) || raw.adult === true) return null;
  const localizedTitle = clean(mediaType === 'movie' ? raw.title : raw.name);
  const originalTitle = clean(mediaType === 'movie' ? raw.original_title : raw.original_name);
  if (!localizedTitle && !originalTitle) return null;
  const genreIds = unique(
    (raw.genre_ids ?? raw.genres?.map((genre) => genre.id ?? 0) ?? []).filter(positiveInteger),
  );
  const originalLanguage = normalizeLanguage(raw.original_language);
  const originCountries = normalizeCountries(
    mediaType === 'movie' && raw.production_countries
      ? raw.production_countries.map((country) => country.iso_3166_1)
      : raw.origin_country,
  );
  const candidate: CatalogCandidate = {
    tmdbId: raw.id,
    mediaType,
    category: category(mediaType, genreIds),
    localizedTitle: localizedTitle || originalTitle,
    originalTitle,
    originalLanguage,
    originCountries,
    aliases: [],
    releaseDate: safeDate(mediaType === 'movie' ? raw.release_date : raw.first_air_date),
    sortDate: safeDate(sortDate),
    rating: finite(raw.vote_average),
    voteCount: Math.max(0, Math.trunc(finite(raw.vote_count))),
    popularity: Math.max(0, finite(raw.popularity)),
    posterPath: typeof raw.poster_path === 'string' ? raw.poster_path : '',
    genreIds,
    seriesType: clean(raw.type),
    candidateKind,
    languageClass: classifyLanguage(originalLanguage, originCountries),
  };
  if (positiveInteger(raw.number_of_seasons)) candidate.numberOfSeasons = raw.number_of_seasons;
  if (positiveInteger(raw.number_of_episodes)) candidate.numberOfEpisodes = raw.number_of_episodes;
  return candidate;
}

export function enrichMovie(candidate: CatalogCandidate, detail: TmdbListItem): CatalogCandidate {
  const originalLanguage =
    normalizeLanguage(detail.original_language) || candidate.originalLanguage;
  const detailedCountries = normalizeCountries(
    detail.production_countries?.map((country) => country.iso_3166_1),
  );
  const originCountries = detailedCountries.length ? detailedCountries : candidate.originCountries;
  return {
    ...candidate,
    originalLanguage,
    originCountries,
    languageClass: classifyLanguage(originalLanguage, originCountries),
  };
}

function category(mediaType: MediaType, genres: number[]): Category {
  if (genres.includes(16)) return 'animation';
  if (mediaType === 'tv' && genres.some((genre) => VARIETY_GENRE_SET.has(genre))) return 'variety';
  return mediaType;
}

function classifyLanguage(language: string, countries: string[]): LanguageClass {
  if (
    CHINESE_LANGUAGES.has(language) ||
    countries.some((country) => CHINESE_COUNTRIES.has(country))
  ) {
    return 'chinese';
  }
  return language || countries.length ? 'foreign' : 'unknown';
}

function normalizeLanguage(value: unknown): string {
  const language = clean(value).toLowerCase();
  return /^[a-z]{2}$/.test(language) ? language : '';
}

function normalizeCountries(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return unique(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toUpperCase())
      .filter((value) => /^[A-Z]{2}$/.test(value)),
  );
}

export function mergeTmdbItem(listItem: TmdbListItem, detail: TmdbListItem): TmdbListItem {
  const detailGenreIds = detail.genre_ids ?? detail.genres?.map((genre) => genre.id ?? 0);
  return {
    ...listItem,
    ...detail,
    ...((detailGenreIds ?? listItem.genre_ids) === undefined
      ? {}
      : { genre_ids: detailGenreIds ?? listItem.genre_ids }),
    ...((detail.origin_country ?? listItem.origin_country) === undefined
      ? {}
      : { origin_country: detail.origin_country ?? listItem.origin_country }),
  };
}

export const present = <T>(value: T | null): value is T => value !== null;
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const safeDate = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
};
export const parseDate = (value: string): Date | undefined => {
  const safe = safeDate(value);
  return safe ? new Date(`${safe}T00:00:00Z`) : undefined;
};
export const validPastDate = (value: string, today: string): boolean =>
  value !== '' && value <= today;
export const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
