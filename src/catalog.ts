import { itemId, type CatalogSnapshot, type FeedName } from './types.js';
import {
  DAY,
  GROUPS,
  LATEST_POLICY,
  TOP_RATED_MIN_VOTES,
  TOP_RATED_VARIETY_MIN_VOTES,
  VARIETY_GENRES,
  VARIETY_LANGUAGES,
  VARIETY_LANGUAGE_ALLOWLIST,
  type CandidateGroups,
  type CatalogCandidate,
  type CatalogGenerationReport,
  type CatalogUpstream,
} from './catalog/domain.js';
import {
  buildLatestGroups,
  buildSnapshot,
  buildStandardGroups,
  dedupe,
  dedupeRaw,
  freshFirst,
  mapGroups,
  popularityFirst,
  ratingFirst,
  returningFirst,
  returningRejection,
  validateGeneratedGroups,
} from './catalog/grouping.js';
import {
  dateOnly,
  enrichMovie,
  mergeTmdbItem,
  normalize,
  positiveInteger,
  present,
  validPastDate,
} from './catalog/normalize.js';
import {
  applyDetailStats,
  countLanguages,
  newReport,
  recordExclusion,
  recordMetadataWarning,
} from './catalog/report.js';

export { LATEST_POLICY } from './catalog/domain.js';
export type { CatalogGenerationReport, CatalogUpstream } from './catalog/domain.js';

export class CatalogGenerator {
  private report?: CatalogGenerationReport;
  private readonly minimumAllItems: number;

  constructor(
    private readonly tmdb: CatalogUpstream,
    options: { minimumAllItems?: number } = {},
  ) {
    this.minimumAllItems = options.minimumAllItems ?? LATEST_POLICY.minimumAllItems;
  }

  lastReport(): CatalogGenerationReport | undefined {
    return this.report;
  }

  async generate(feed: FeedName, now = new Date()): Promise<CatalogSnapshot> {
    this.tmdb.consumeDetailStats?.();
    const report = newReport(feed);
    try {
      const groups =
        feed === 'latest' ? await this.latest(now, report) : await this.standard(feed, report);
      const snapshot = buildSnapshot(feed, groups, now, this.minimumAllItems);
      validateGeneratedGroups(feed, groups);
      countLanguages(groups, report);
      report.finalItems = Object.keys(snapshot.items).length;
      return snapshot;
    } finally {
      applyDetailStats(report, this.tmdb.consumeDetailStats?.());
      this.report = report;
    }
  }

  private async latest(now: Date, report: CatalogGenerationReport): Promise<CandidateGroups> {
    const today = dateOnly(now);
    const freshCutoff = dateOnly(new Date(now.getTime() - LATEST_POLICY.freshWindowDays * DAY));
    const returningCutoff = dateOnly(
      new Date(now.getTime() - LATEST_POLICY.returningRecentDays * DAY),
    );
    const airingThrough = dateOnly(new Date(now.getTime() + 7 * DAY));
    const recentTvParams = {
      sort_by: 'popularity.desc',
      'first_air_date.gte': freshCutoff,
      'first_air_date.lte': today,
      include_adult: 'false',
      language: 'zh-CN',
    };
    const varietyParams = {
      sort_by: 'popularity.desc',
      include_adult: 'false',
      language: 'zh-CN',
      with_genres: VARIETY_GENRES.join('|'),
    };
    const [movies, newTv, onAir, newVarietyByLanguage, airingVarietyByLanguage] = await Promise.all(
      [
        this.tmdb.discoverMovies({
          sort_by: 'popularity.desc',
          'primary_release_date.gte': freshCutoff,
          'primary_release_date.lte': today,
          include_adult: 'false',
          include_video: 'false',
          language: 'zh-CN',
        }),
        this.tmdb.discoverTv(recentTvParams),
        this.tmdb.onTheAir(),
        Promise.all(
          VARIETY_LANGUAGES.map((originalLanguage) =>
            this.tmdb.discoverTv({
              ...recentTvParams,
              with_genres: VARIETY_GENRES.join('|'),
              with_original_language: originalLanguage,
            }),
          ),
        ),
        Promise.all(
          VARIETY_LANGUAGES.map((originalLanguage) =>
            this.tmdb.discoverTv({
              ...varietyParams,
              'air_date.gte': today,
              'air_date.lte': airingThrough,
              with_original_language: originalLanguage,
            }),
          ),
        ),
      ],
    );

    const newTvCandidates = [...newTv, ...newVarietyByLanguage.flat()];
    const onAirCandidates = [...onAir, ...airingVarietyByLanguage.flat()];
    report.rawCandidates = movies.length + newTvCandidates.length + onAirCandidates.length;

    const fresh = dedupe(
      [
        ...movies.map((item) => normalize(item, 'movie', item.release_date ?? '', 'fresh')),
        ...newTvCandidates.map((item) => normalize(item, 'tv', item.first_air_date ?? '', 'fresh')),
      ]
        .filter(present)
        .filter((item) => this.admitVariety(item, report))
        .filter(
          (item) =>
            item.popularity >= LATEST_POLICY.minimumPopularity &&
            validPastDate(item.sortDate, today) &&
            item.releaseDate >= freshCutoff,
        ),
      freshFirst,
    );
    const freshIds = new Set(fresh.map(itemId));

    const rawReturning = dedupeRaw(
      onAirCandidates.filter(
        (item) => positiveInteger(item.id) && !freshIds.has(`tmdb:tv:${item.id}`),
      ),
    );
    const detailResults = await Promise.all(
      rawReturning.map(async (raw) => {
        try {
          return { raw, detail: await this.tmdb.tvDetail(raw.id as number) };
        } catch {
          return { raw };
        }
      }),
    );

    const returning: CatalogCandidate[] = [];
    for (const result of detailResults) {
      const combined = result.detail ? mergeTmdbItem(result.raw, result.detail) : result.raw;
      const episode = combined.last_episode_to_air;
      const candidate = normalize(combined, 'tv', episode?.air_date ?? '', 'returning');
      if (!candidate) continue;
      if (!this.admitVariety(candidate, report)) continue;
      if (!candidate.sortDate) {
        report.unknownMetadata += 1;
        recordExclusion(report, candidate, 'missing_recent_episode_date');
        continue;
      }
      if (
        candidate.popularity < LATEST_POLICY.minimumPopularity ||
        !validPastDate(candidate.sortDate, today) ||
        candidate.sortDate < returningCutoff ||
        !candidate.releaseDate ||
        candidate.releaseDate >= freshCutoff ||
        freshIds.has(itemId(candidate))
      ) {
        continue;
      }
      if (positiveInteger(episode?.season_number))
        candidate.latestSeasonNumber = episode.season_number;
      const rejection = returningRejection(candidate, now);
      if (rejection) {
        report[rejection.counter] += 1;
        recordExclusion(report, candidate, rejection.reason);
        continue;
      }
      if (
        candidate.languageClass !== 'chinese' &&
        candidate.category === 'tv' &&
        (candidate.numberOfEpisodes === undefined || candidate.numberOfSeasons === undefined)
      ) {
        report.unknownMetadata += 1;
        recordMetadataWarning(report, candidate, 'unknown_metadata');
      }
      returning.push(candidate);
    }

    const sortedReturning = dedupe(returning, returningFirst);
    report.freshItems = fresh.length;
    report.returningItems = sortedReturning.length;
    return this.enrichSelectedMovies(buildLatestGroups(fresh, sortedReturning), report);
  }

  private async standard(
    feed: Exclude<FeedName, 'latest'>,
    report: CatalogGenerationReport,
  ): Promise<CandidateGroups> {
    let candidates: CatalogCandidate[];
    if (feed === 'popular') {
      const [movies, tv, varietyByLanguage] = await Promise.all([
        this.tmdb.trending('movie'),
        this.tmdb.trending('tv'),
        Promise.all(
          VARIETY_LANGUAGES.map((originalLanguage) =>
            this.tmdb.discoverTv({
              sort_by: 'popularity.desc',
              include_adult: 'false',
              language: 'zh-CN',
              with_genres: VARIETY_GENRES.join('|'),
              with_original_language: originalLanguage,
            }),
          ),
        ),
      ]);
      report.rawCandidates = movies.length + tv.length + varietyByLanguage.flat().length;
      candidates = dedupe(
        [
          ...movies.map((item) => normalize(item, 'movie', item.release_date ?? '', 'standard')),
          ...[...tv, ...varietyByLanguage.flat()].map((item) =>
            normalize(item, 'tv', item.first_air_date ?? '', 'standard'),
          ),
        ]
          .filter(present)
          .filter((item) => this.admitVariety(item, report)),
        popularityFirst,
      );
    } else {
      const commonParams = {
        sort_by: 'vote_average.desc',
        'vote_average.gte': '7.0',
        include_adult: 'false',
        language: 'zh-CN',
      };
      const [movies, tv, ...varietyByLanguage] = await Promise.all([
        this.tmdb.discoverMovies({
          ...commonParams,
          'vote_count.gte': String(TOP_RATED_MIN_VOTES),
        }),
        this.tmdb.discoverTv({
          ...commonParams,
          'vote_count.gte': String(TOP_RATED_MIN_VOTES),
        }),
        ...VARIETY_LANGUAGES.map((originalLanguage) =>
          this.tmdb.discoverTv({
            ...commonParams,
            'vote_count.gte': String(TOP_RATED_VARIETY_MIN_VOTES),
            with_genres: VARIETY_GENRES.join('|'),
            with_original_language: originalLanguage,
          }),
        ),
      ]);
      report.rawCandidates = movies.length + tv.length + varietyByLanguage.flat().length;
      candidates = dedupe(
        [
          ...movies.map((item) => normalize(item, 'movie', item.release_date ?? '', 'standard')),
          ...[...tv, ...varietyByLanguage.flat()].map((item) =>
            normalize(item, 'tv', item.first_air_date ?? '', 'standard'),
          ),
        ]
          .filter(present)
          .filter((item) => this.admitVariety(item, report))
          .filter(
            (item) =>
              item.rating >= 7 &&
              item.voteCount >=
                (item.category === 'variety' ? TOP_RATED_VARIETY_MIN_VOTES : TOP_RATED_MIN_VOTES),
          ),
        ratingFirst,
      );
    }
    return this.enrichSelectedMovies(buildStandardGroups(candidates), report);
  }

  private admitVariety(candidate: CatalogCandidate, report: CatalogGenerationReport): boolean {
    if (
      candidate.category !== 'variety' ||
      VARIETY_LANGUAGE_ALLOWLIST.has(candidate.originalLanguage)
    ) {
      return true;
    }
    report.excludedVarietyLanguage += 1;
    recordExclusion(report, candidate, 'variety_language_not_allowed');
    return false;
  }

  private async enrichSelectedMovies(
    groups: CandidateGroups,
    report: CatalogGenerationReport,
  ): Promise<CandidateGroups> {
    const selectedMovies = new Map<number, CatalogCandidate>();
    for (const group of GROUPS) {
      for (const candidate of groups[group]) {
        if (candidate.mediaType === 'movie') selectedMovies.set(candidate.tmdbId, candidate);
      }
    }
    const enriched = new Map<number, CatalogCandidate>();
    await Promise.all(
      [...selectedMovies.values()].map(async (candidate) => {
        try {
          const detail = await this.tmdb.movieDetail(candidate.tmdbId);
          enriched.set(candidate.tmdbId, enrichMovie(candidate, detail));
        } catch {
          enriched.set(candidate.tmdbId, candidate);
          report.unknownMetadata += 1;
          recordMetadataWarning(report, candidate, 'movie_detail_failed');
        }
      }),
    );
    return mapGroups(groups, (candidate) => enriched.get(candidate.tmdbId) ?? candidate);
  }
}
