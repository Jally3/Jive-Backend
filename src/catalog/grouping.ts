import { CATALOG_POLICY } from '../catalog-policy.js';
import type { TmdbListItem } from '../tmdb-client.js';
import { itemId, type CatalogItem, type CatalogSnapshot, type FeedName } from '../types.js';
import {
  GROUPS,
  LATEST_POLICY,
  YEAR,
  type CandidateGroups,
  type CandidateKind,
  type CatalogCandidate,
} from './domain.js';
import { parseDate, positiveInteger } from './normalize.js';

export function buildLatestGroups(
  fresh: CatalogCandidate[],
  returning: CatalogCandidate[],
): CandidateGroups {
  return Object.fromEntries(
    GROUPS.map((group) => {
      const inGroup = (candidate: CatalogCandidate) =>
        group === 'all' || candidate.category === group;
      return [group, mergeLatestCandidates(fresh.filter(inGroup), returning.filter(inGroup))];
    }),
  ) as CandidateGroups;
}

function mergeLatestCandidates(
  fresh: CatalogCandidate[],
  returning: CatalogCandidate[],
): CatalogCandidate[] {
  const output: CatalogCandidate[] = [];
  let freshIndex = 0;
  let returningIndex = 0;
  const template: CandidateKind[] = [
    'fresh',
    'fresh',
    'returning',
    'fresh',
    'fresh',
    'returning',
    'fresh',
    'fresh',
    'returning',
    'fresh',
  ];
  while (output.length < 200 && (freshIndex < fresh.length || returningIndex < returning.length)) {
    const freshChunk = fresh.slice(freshIndex, freshIndex + LATEST_POLICY.freshTargetPerWindow);
    freshIndex += freshChunk.length;
    const returningChunk: CatalogCandidate[] = [];
    let foreignAnimationCount = 0;
    while (
      returningIndex < returning.length &&
      returningChunk.length < LATEST_POLICY.returningMaxPerWindow
    ) {
      const candidate = returning[returningIndex]!;
      const foreignAnimation =
        candidate.category === 'animation' && candidate.languageClass === 'foreign';
      if (
        foreignAnimation &&
        foreignAnimationCount >= LATEST_POLICY.foreignReturningAnimationMaxPerWindow
      ) {
        break;
      }
      returningIndex += 1;
      returningChunk.push(candidate);
      if (foreignAnimation) foreignAnimationCount += 1;
    }
    while (
      freshIndex < fresh.length &&
      freshChunk.length + returningChunk.length < LATEST_POLICY.windowSize
    ) {
      freshChunk.push(fresh[freshIndex]!);
      freshIndex += 1;
    }
    if (freshChunk.length === 0 && returningChunk.length === 0) break;
    let freshChunkIndex = 0;
    let returningChunkIndex = 0;
    for (let slot = 0; slot < LATEST_POLICY.windowSize; slot += 1) {
      const preferred = template[slot % template.length];
      const takeFresh = () => freshChunk[freshChunkIndex++];
      const takeReturning = () => returningChunk[returningChunkIndex++];
      const candidate =
        preferred === 'fresh'
          ? freshChunkIndex < freshChunk.length
            ? takeFresh()
            : returningChunkIndex < returningChunk.length
              ? takeReturning()
              : undefined
          : returningChunkIndex < returningChunk.length
            ? takeReturning()
            : freshChunkIndex < freshChunk.length
              ? takeFresh()
              : undefined;
      if (candidate) output.push(candidate);
      if (output.length >= 200) break;
    }
    if (freshChunk.length + returningChunk.length < LATEST_POLICY.windowSize) break;
  }
  return output;
}

export function buildStandardGroups(candidates: CatalogCandidate[]): CandidateGroups {
  return Object.fromEntries(
    GROUPS.map((group) => [
      group,
      candidates.filter((item) => group === 'all' || item.category === group).slice(0, 200),
    ]),
  ) as CandidateGroups;
}

export function buildSnapshot(
  feed: FeedName,
  groups: CandidateGroups,
  now: Date,
  minimumAllItems: number,
): CatalogSnapshot {
  if (groups.all.length < minimumAllItems) {
    throw new Error(`${feed} generated ${groups.all.length} items; minimum is ${minimumAllItems}`);
  }
  const ids = Object.fromEntries(
    GROUPS.map((group) => [group, groups[group].map(itemId)]),
  ) as CatalogSnapshot['groups'];
  const selected = new Map<string, CatalogItem>();
  for (const group of GROUPS) {
    for (const candidate of groups[group]) selected.set(itemId(candidate), publicItem(candidate));
  }
  const generatedAt = now.toISOString();
  return {
    schemaVersion: 1,
    revision: revision(now),
    feed,
    generatedAt,
    expiresAt: new Date(now.getTime() + CATALOG_POLICY[feed].freshForMs).toISOString(),
    stale: false,
    groups: ids,
    items: Object.fromEntries(selected),
  };
}

function publicItem(candidate: CatalogCandidate): CatalogItem {
  return {
    tmdbId: candidate.tmdbId,
    mediaType: candidate.mediaType,
    category: candidate.category,
    localizedTitle: candidate.localizedTitle,
    originalTitle: candidate.originalTitle,
    originalLanguage: candidate.originalLanguage,
    originCountries: candidate.originCountries,
    aliases: candidate.aliases,
    releaseDate: candidate.releaseDate,
    sortDate: candidate.sortDate,
    ...(candidate.latestSeasonNumber === undefined
      ? {}
      : { latestSeasonNumber: candidate.latestSeasonNumber }),
    rating: candidate.rating,
    voteCount: candidate.voteCount,
    popularity: candidate.popularity,
    posterPath: candidate.posterPath,
  };
}

export function validateGeneratedGroups(feed: FeedName, groups: CandidateGroups): void {
  for (const group of GROUPS) {
    const candidates = groups[group];
    if (candidates.length > 200 || new Set(candidates.map(itemId)).size !== candidates.length) {
      throw new Error(`invalid generated ${feed}.${group} group`);
    }
    if (feed !== 'latest') continue;
    for (let offset = 0; offset < candidates.length; offset += LATEST_POLICY.windowSize) {
      const window = candidates.slice(offset, offset + LATEST_POLICY.windowSize);
      if (
        window.filter((item) => item.candidateKind === 'returning').length >
        LATEST_POLICY.returningMaxPerWindow
      ) {
        throw new Error(`too many returning items in ${feed}.${group} at ${offset}`);
      }
      if (
        window.filter(
          (item) =>
            item.candidateKind === 'returning' &&
            item.category === 'animation' &&
            item.languageClass === 'foreign',
        ).length > LATEST_POLICY.foreignReturningAnimationMaxPerWindow
      ) {
        throw new Error(`too many foreign returning animations in ${feed}.${group} at ${offset}`);
      }
    }
  }
}

export function returningRejection(
  candidate: CatalogCandidate,
  now: Date,
): {
  counter: 'excludedSoap' | 'excludedVeryLong' | 'excludedHighFrequency';
  reason: string;
} | null {
  if (candidate.languageClass !== 'foreign' || candidate.category !== 'tv') return null;
  if (candidate.genreIds.includes(10766))
    return { counter: 'excludedSoap', reason: 'foreign_soap' };
  const released = parseDate(candidate.releaseDate);
  if (!released) return null;
  const ageYears = Math.max(1, (now.getTime() - released.getTime()) / YEAR);
  if (ageYears >= 5 && (candidate.numberOfEpisodes ?? 0) >= 500) {
    return { counter: 'excludedVeryLong', reason: 'foreign_very_long_series' };
  }
  if (ageYears >= 5 && (candidate.numberOfSeasons ?? 0) >= 8 && candidate.voteCount < 500) {
    return { counter: 'excludedVeryLong', reason: 'foreign_many_seasons_low_votes' };
  }
  if (
    ageYears >= 3 &&
    (candidate.numberOfEpisodes ?? 0) >= 200 &&
    (candidate.numberOfEpisodes ?? 0) / ageYears > 80
  ) {
    return { counter: 'excludedHighFrequency', reason: 'foreign_high_frequency_series' };
  }
  return null;
}

export function mapGroups(
  groups: CandidateGroups,
  mapper: (candidate: CatalogCandidate) => CatalogCandidate,
): CandidateGroups {
  return Object.fromEntries(
    GROUPS.map((group) => [group, groups[group].map(mapper)]),
  ) as CandidateGroups;
}

export function dedupe(
  items: CatalogCandidate[],
  compare: (left: CatalogCandidate, right: CatalogCandidate) => number,
): CatalogCandidate[] {
  const values = new Map<string, CatalogCandidate>();
  for (const item of items) {
    const id = itemId(item);
    const existing = values.get(id);
    if (!existing || compare(item, existing) < 0) values.set(id, item);
  }
  return [...values.values()].sort(compare);
}

export function dedupeRaw(items: TmdbListItem[]): TmdbListItem[] {
  const values = new Map<number, TmdbListItem>();
  for (const item of items) {
    if (positiveInteger(item.id) && !values.has(item.id)) values.set(item.id, item);
  }
  return [...values.values()];
}

export const freshFirst = (left: CatalogCandidate, right: CatalogCandidate) =>
  right.releaseDate.localeCompare(left.releaseDate) ||
  right.popularity - left.popularity ||
  right.voteCount - left.voteCount ||
  itemId(left).localeCompare(itemId(right));
export const returningFirst = (left: CatalogCandidate, right: CatalogCandidate) =>
  right.sortDate.localeCompare(left.sortDate) ||
  right.popularity - left.popularity ||
  right.voteCount - left.voteCount ||
  itemId(left).localeCompare(itemId(right));
export const popularityFirst = (left: CatalogCandidate, right: CatalogCandidate) =>
  right.popularity - left.popularity ||
  right.voteCount - left.voteCount ||
  itemId(left).localeCompare(itemId(right));
export const ratingFirst = (left: CatalogCandidate, right: CatalogCandidate) =>
  right.rating - left.rating ||
  right.voteCount - left.voteCount ||
  itemId(left).localeCompare(itemId(right));

const revision = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
