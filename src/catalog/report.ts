import { itemId, type FeedName } from '../types.js';
import type { TmdbDetailStats } from '../tmdb-client.js';
import {
  GROUPS,
  type CandidateGroups,
  type CatalogCandidate,
  type CatalogGenerationReport,
} from './domain.js';

export function recordExclusion(
  report: CatalogGenerationReport,
  candidate: CatalogCandidate,
  reason: string,
): void {
  if (report.excludedSamples.length >= 100) return;
  report.excludedSamples.push({
    tmdbId: candidate.tmdbId,
    mediaType: candidate.mediaType,
    title: candidate.localizedTitle,
    reason,
    originalLanguage: candidate.originalLanguage,
    originCountries: candidate.originCountries,
    ...(candidate.numberOfEpisodes === undefined
      ? {}
      : { numberOfEpisodes: candidate.numberOfEpisodes }),
  });
}

export function recordMetadataWarning(
  report: CatalogGenerationReport,
  candidate: CatalogCandidate,
  reason: string,
): void {
  if (report.metadataWarnings.length >= 100) return;
  report.metadataWarnings.push({
    tmdbId: candidate.tmdbId,
    mediaType: candidate.mediaType,
    title: candidate.localizedTitle,
    reason,
    originalLanguage: candidate.originalLanguage,
    originCountries: candidate.originCountries,
  });
}

export function countLanguages(groups: CandidateGroups, report: CatalogGenerationReport): void {
  const items = new Map<string, CatalogCandidate>();
  for (const group of GROUPS) {
    for (const candidate of groups[group]) items.set(itemId(candidate), candidate);
  }
  for (const candidate of items.values()) {
    if (candidate.languageClass === 'chinese') report.chineseItems += 1;
    else if (candidate.languageClass === 'foreign') report.foreignItems += 1;
    else report.unknownLanguageItems += 1;
  }
}

export function newReport(feed: FeedName): CatalogGenerationReport {
  return {
    feed,
    rawCandidates: 0,
    freshItems: 0,
    returningItems: 0,
    excludedSoap: 0,
    excludedVeryLong: 0,
    excludedHighFrequency: 0,
    excludedVarietyLanguage: 0,
    unknownMetadata: 0,
    chineseItems: 0,
    foreignItems: 0,
    unknownLanguageItems: 0,
    detailCacheHits: 0,
    detailUpstreamSuccesses: 0,
    detailFailures: 0,
    detailRetries: 0,
    finalItems: 0,
    excludedSamples: [],
    metadataWarnings: [],
  };
}

export function applyDetailStats(
  report: CatalogGenerationReport,
  stats: TmdbDetailStats | undefined,
): void {
  if (!stats) return;
  report.detailCacheHits = stats.cacheHits;
  report.detailUpstreamSuccesses = stats.upstreamSuccesses;
  report.detailFailures = stats.failures;
  report.detailRetries = stats.retries;
}
