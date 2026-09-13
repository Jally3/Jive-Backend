import { describe, expect, it } from 'vitest';
import { CatalogGenerator, type CatalogUpstream } from '../src/catalog.js';
import type { TmdbListItem } from '../src/tmdb-client.js';

class StubTmdb implements CatalogUpstream {
  movies: TmdbListItem[] = [];
  tv: TmdbListItem[] = [];
  varietyTv = new Map<string, TmdbListItem[]>();
  newVarietyTv = new Map<string, TmdbListItem[]>();
  airingVarietyTv = new Map<string, TmdbListItem[]>();
  discoverTvParams: Record<string, string>[] = [];
  onAir: TmdbListItem[] = [];
  details = new Map<number, TmdbListItem>();
  movieDetails = new Map<number, TmdbListItem>();
  movieDetailFailures = new Set<number>();

  discoverMovies(): Promise<TmdbListItem[]> {
    return Promise.resolve(this.movies);
  }
  discoverTv(params: Record<string, string>): Promise<TmdbListItem[]> {
    this.discoverTvParams.push(params);
    const originalLanguage = params.with_original_language;
    if (originalLanguage && params['first_air_date.gte']) {
      return Promise.resolve(this.newVarietyTv.get(originalLanguage) ?? []);
    }
    if (originalLanguage && params['air_date.gte']) {
      return Promise.resolve(this.airingVarietyTv.get(originalLanguage) ?? []);
    }
    return Promise.resolve(
      originalLanguage ? (this.varietyTv.get(originalLanguage) ?? []) : this.tv,
    );
  }
  onTheAir(): Promise<TmdbListItem[]> {
    return Promise.resolve(this.onAir);
  }
  trending(mediaType: 'movie' | 'tv'): Promise<TmdbListItem[]> {
    return Promise.resolve(mediaType === 'movie' ? this.movies : this.tv);
  }
  tvDetail(id: number): Promise<TmdbListItem> {
    const detail = this.details.get(id);
    if (!detail) throw new Error('missing detail');
    return Promise.resolve(detail);
  }
  movieDetail(id: number): Promise<TmdbListItem> {
    if (this.movieDetailFailures.has(id)) return Promise.reject(new Error('missing movie detail'));
    return Promise.resolve(this.movieDetails.get(id) ?? { id });
  }
}

const generator = (tmdb: StubTmdb) => new CatalogGenerator(tmdb, { minimumAllItems: 1 });

describe('CatalogGenerator', () => {
  it('builds mutually exclusive groups and filters adult or titleless entries', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [
      movie(1, '电影', 50, [28]),
      movie(2, '动画', 100, [16]),
      { ...movie(3, '成人', 200, [28]), adult: true },
      { ...movie(4, '', 300, [28]), original_title: '' },
    ];
    tmdb.tv = [tv(5, '电视剧', 80, [18]), tv(6, '综艺', 90, [10764])];

    const snapshot = await generator(tmdb).generate('popular', new Date('2026-09-08T12:00:00Z'));

    expect(snapshot.groups.all).toEqual(['tmdb:movie:2', 'tmdb:tv:6', 'tmdb:tv:5', 'tmdb:movie:1']);
    expect(snapshot.groups.animation).toEqual(['tmdb:movie:2']);
    expect(snapshot.groups.variety).toEqual(['tmdb:tv:6']);
    expect(snapshot.groups.movie).toEqual(['tmdb:movie:1']);
    expect(snapshot.groups.tv).toEqual(['tmdb:tv:5']);
    expect(snapshot.items).not.toHaveProperty('tmdb:movie:3');
  });

  it('keeps only Chinese, Japanese, and Korean variety shows', async () => {
    const tmdb = new StubTmdb();
    const missingLanguageVariety = tv(13, '语言缺失综艺', 40, [10764]);
    delete missingLanguageVariety.original_language;
    tmdb.tv = [
      { ...tv(7, '英语综艺', 100, [10764]), original_language: 'en' },
      { ...tv(8, '韩语综艺', 90, [10764]), original_language: 'ko' },
      { ...tv(9, '英语剧集', 80, [18]), original_language: 'en' },
      { ...tv(10, '中文综艺', 70, [10767]), original_language: 'zh' },
      { ...tv(11, '日语综艺', 60, [10763]), original_language: 'ja' },
      { ...tv(12, '法语综艺', 50, [10764]), original_language: 'fr' },
      { ...tv(14, '粤语综艺', 45, [10764]), original_language: 'cn' },
      missingLanguageVariety,
    ];

    const snapshot = await generator(tmdb).generate('popular');

    expect(snapshot.groups.all).toEqual(['tmdb:tv:8', 'tmdb:tv:9', 'tmdb:tv:10', 'tmdb:tv:11']);
    expect(snapshot.groups.variety).toEqual(['tmdb:tv:8', 'tmdb:tv:10', 'tmdb:tv:11']);
    expect(snapshot.groups.tv).toEqual(['tmdb:tv:9']);
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:7');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:12');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:13');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:14');
  });

  it('uses the latest episode date and season for returning TV', async () => {
    const tmdb = new StubTmdb();
    tmdb.onAir = [{ id: 20 }];
    tmdb.details.set(20, {
      id: 20,
      name: '老剧新季',
      original_name: 'Returning Show',
      first_air_date: '2015-01-01',
      popularity: 30,
      genre_ids: [18],
      last_episode_to_air: { air_date: '2026-09-01', season_number: 4 },
    });

    const snapshot = await generator(tmdb).generate('latest', new Date('2026-09-08T12:00:00Z'));
    expect(snapshot.items['tmdb:tv:20']).toMatchObject({
      sortDate: '2026-09-01',
      latestSeasonNumber: 4,
    });
  });

  it('adds per-language new and airing variety pools to latest', async () => {
    const tmdb = new StubTmdb();
    tmdb.newVarietyTv.set('zh', [
      { ...tv(30, '中文新综艺', 30, [10764]), first_air_date: '2026-09-01' },
    ]);
    tmdb.newVarietyTv.set('ja', [
      {
        ...tv(31, '日语新综艺', 20, [10767]),
        original_language: 'ja',
        first_air_date: '2026-08-20',
      },
    ]);
    tmdb.airingVarietyTv.set('ko', [
      {
        ...tv(32, '韩语在播综艺', 40, [10764]),
        original_language: 'ko',
        first_air_date: '2015-01-01',
      },
    ]);
    tmdb.details.set(32, {
      ...tv(32, '韩语在播综艺', 40, [10764]),
      original_language: 'ko',
      first_air_date: '2015-01-01',
      last_episode_to_air: { air_date: '2026-09-07', season_number: 10 },
    });

    const snapshot = await generator(tmdb).generate('latest', new Date('2026-09-08T12:00:00Z'));

    expect(snapshot.groups.variety).toEqual(['tmdb:tv:30', 'tmdb:tv:31', 'tmdb:tv:32']);
    expect(snapshot.items['tmdb:tv:32']).toMatchObject({
      sortDate: '2026-09-07',
      latestSeasonNumber: 10,
    });
    const languageRequests = tmdb.discoverTvParams.filter(
      (params) => params.with_original_language,
    );
    expect(languageRequests).toHaveLength(6);
    expect(languageRequests.slice(0, 3).map((params) => params.with_original_language)).toEqual([
      'zh',
      'ja',
      'ko',
    ]);
    expect(languageRequests.slice(3).map((params) => params.with_original_language)).toEqual([
      'zh',
      'ja',
      'ko',
    ]);
    expect(languageRequests[3]).toMatchObject({
      'air_date.gte': '2026-09-08',
      'air_date.lte': '2026-09-15',
      with_genres: '10763|10764|10767',
    });
  });

  it('adds per-language variety pools to popular and sorts by popularity', async () => {
    const tmdb = new StubTmdb();
    tmdb.tv = [{ ...tv(43, '英语剧集', 100, [18]), original_language: 'en' }];
    tmdb.varietyTv.set('zh', [tv(40, '中文热门综艺', 30, [10764])]);
    tmdb.varietyTv.set('ja', [{ ...tv(41, '日语热门综艺', 50, [10767]), original_language: 'ja' }]);
    tmdb.varietyTv.set('ko', [{ ...tv(42, '韩语热门综艺', 40, [10763]), original_language: 'ko' }]);

    const snapshot = await generator(tmdb).generate('popular');

    expect(snapshot.groups.variety).toEqual(['tmdb:tv:41', 'tmdb:tv:42', 'tmdb:tv:40']);
    expect(tmdb.discoverTvParams).toHaveLength(3);
    expect(
      tmdb.discoverTvParams.map((params) => ({
        language: params.with_original_language,
        genres: params.with_genres,
        sort: params.sort_by,
      })),
    ).toEqual([
      { language: 'zh', genres: '10763|10764|10767', sort: 'popularity.desc' },
      { language: 'ja', genres: '10763|10764|10767', sort: 'popularity.desc' },
      { language: 'ko', genres: '10763|10764|10767', sort: 'popularity.desc' },
    ]);
  });

  it('orders top-rated items by rating and then vote count', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [
      { ...movie(1, 'A', 1, [28]), vote_average: 8, vote_count: 300 },
      { ...movie(2, 'B', 1, [28]), vote_average: 8, vote_count: 500 },
      { ...movie(3, 'C', 1, [28]), vote_average: 6.9, vote_count: 5000 },
    ];
    const snapshot = await generator(tmdb).generate('top_rated');
    expect(snapshot.groups.all).toEqual(['tmdb:movie:2', 'tmdb:movie:1']);
  });

  it('fetches a separate top-rated variety pool for each allowed language', async () => {
    const tmdb = new StubTmdb();
    tmdb.varietyTv.set('zh', [
      { ...tv(20, '中文综艺', 1, [10764]), vote_average: 8.2, vote_count: 20 },
      { ...tv(24, '低票数综艺', 1, [10764]), vote_average: 9.5, vote_count: 19 },
    ]);
    tmdb.varietyTv.set('ja', [
      {
        ...tv(21, '日语综艺', 1, [10767]),
        original_language: 'ja',
        vote_average: 8.5,
        vote_count: 60,
      },
    ]);
    tmdb.varietyTv.set('ko', [
      {
        ...tv(22, '韩语综艺', 1, [10763]),
        original_language: 'ko',
        vote_average: 8.5,
        vote_count: 90,
      },
      {
        ...tv(23, '法语综艺', 1, [10764]),
        original_language: 'fr',
        vote_average: 9.8,
        vote_count: 500,
      },
    ]);

    const snapshot = await generator(tmdb).generate('top_rated');

    expect(snapshot.groups.variety).toEqual(['tmdb:tv:22', 'tmdb:tv:21', 'tmdb:tv:20']);
    expect(
      tmdb.discoverTvParams.slice(1).map((params) => ({
        language: params.with_original_language,
        genres: params.with_genres,
        minimumVotes: params['vote_count.gte'],
      })),
    ).toEqual([
      { language: 'zh', genres: '10763|10764|10767', minimumVotes: '20' },
      { language: 'ja', genres: '10763|10764|10767', minimumVotes: '20' },
      { language: 'ko', genres: '10763|10764|10767', minimumVotes: '20' },
    ]);
    expect(tmdb.discoverTvParams[0]).toMatchObject({ 'vote_count.gte': '200' });
  });

  it('normalizes language and country metadata and enriches selected movies', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [{ ...movie(50, '合拍电影', 50, [18]), original_language: ' ZH ' }];
    tmdb.movieDetails.set(50, {
      id: 50,
      original_language: 'ZH',
      production_countries: [{ iso_3166_1: 'cn' }, { iso_3166_1: 'CN' }, { iso_3166_1: 'invalid' }],
    });

    const snapshot = await generator(tmdb).generate('popular');

    expect(snapshot.items['tmdb:movie:50']).toMatchObject({
      originalLanguage: 'zh',
      originCountries: ['CN'],
    });
  });

  it('filters only foreign long-running ordinary TV and keeps Chinese, animation and variety', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = Array.from({ length: 20 }, (_, index) =>
      movie(index + 1, `新片${index}`, 50, [18]),
    );
    tmdb.tv = [
      {
        ...tv(90, '刚开播的外语 Soap', 60, [18, 10766]),
        original_language: 'en',
        number_of_episodes: 1000,
      },
    ];
    tmdb.onAir = [100, 101, 102, 103, 104, 105, 106].map((id) => ({ id }));
    const soap = returningTv(100, '外语 Soap', 'en', [18, 10766], 100, 2);
    delete soap.genre_ids;
    soap.genres = [{ id: 18 }, { id: 10766 }];
    tmdb.details.set(100, soap);
    tmdb.details.set(101, returningTv(101, '超长剧', 'en', [18], 600, 10));
    tmdb.details.set(102, {
      ...returningTv(102, '高频剧', 'en', [18], 400, 4),
      first_air_date: '2022-09-01',
    });
    tmdb.details.set(103, returningTv(103, '华语 Soap', 'zh', [18, 10766], 6000, 30));
    tmdb.details.set(104, returningTv(104, '韩语老综艺', 'ko', [10764], 600, 12));
    tmdb.details.set(105, {
      ...returningTv(105, '中国来源英语 Soap', 'en', [18, 10766], 6000, 30),
      origin_country: ['CN'],
    });
    const missingCounts = returningTv(106, '元数据不完整外语老剧', 'en', [18], 20, 2);
    delete missingCounts.number_of_episodes;
    delete missingCounts.number_of_seasons;
    tmdb.details.set(106, missingCounts);

    const catalog = generator(tmdb);
    const snapshot = await catalog.generate('latest', new Date('2026-09-13T12:00:00Z'));

    expect(snapshot.items).not.toHaveProperty('tmdb:tv:100');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:101');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:102');
    expect(snapshot.items).toHaveProperty('tmdb:tv:90');
    expect(snapshot.items).toHaveProperty('tmdb:tv:103');
    expect(snapshot.items).toHaveProperty('tmdb:tv:104');
    expect(snapshot.items).toHaveProperty('tmdb:tv:105');
    expect(snapshot.items).toHaveProperty('tmdb:tv:106');
    expect(catalog.lastReport()).toMatchObject({
      excludedSoap: 1,
      excludedVeryLong: 1,
      excludedHighFrequency: 1,
      unknownMetadata: 1,
    });
  });

  it('limits returning items to six per 20-item block and computes groups independently', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = Array.from({ length: 20 }, (_, index) => ({
      ...movie(index + 1, `新片${index}`, 100 - index, [18]),
      release_date: `2026-09-${String(12 - Math.floor(index / 2)).padStart(2, '0')}`,
    }));
    tmdb.onAir = Array.from({ length: 10 }, (_, index) => ({ id: 100 + index }));
    for (let index = 0; index < 10; index += 1) {
      tmdb.details.set(
        100 + index,
        returningTv(100 + index, `华语老剧${index}`, 'zh', [18], 20, 2),
      );
    }

    const snapshot = await generator(tmdb).generate('latest', new Date('2026-09-13T12:00:00Z'));
    const firstBlock = snapshot.groups.all.slice(0, 20);

    expect(firstBlock.filter((id) => id.startsWith('tmdb:tv:')).length).toBe(6);
    expect(snapshot.groups.tv).toHaveLength(6);
    expect(snapshot.groups.movie).toHaveLength(20);
  });

  it('allows at most one foreign returning animation in each 20-item block', async () => {
    const tmdb = new StubTmdb();
    tmdb.tv = Array.from({ length: 40 }, (_, index) => ({
      ...tv(index + 1, `新动画${index}`, 100 - index, [16]),
      first_air_date: '2026-09-01',
    }));
    tmdb.onAir = [200, 201, 202].map((id) => ({ id }));
    for (const id of [200, 201, 202]) {
      tmdb.details.set(id, returningTv(id, `外语老动画${id}`, 'en', [16], 500, 10));
    }

    const snapshot = await generator(tmdb).generate('latest', new Date('2026-09-13T12:00:00Z'));
    for (let offset = 0; offset < snapshot.groups.animation.length; offset += 20) {
      const block = snapshot.groups.animation.slice(offset, offset + 20);
      expect(block.filter((id) => Number(id.split(':').at(-1)) >= 200)).toHaveLength(1);
    }
  });

  it('keeps movies when detail fails and skips returning TV without a recent episode date', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [movie(70, '详情失败电影', 50, [18])];
    tmdb.movieDetailFailures.add(70);
    tmdb.onAir = [{ id: 300, name: '详情失败老剧', first_air_date: '2010-01-01', popularity: 50 }];

    const snapshot = await generator(tmdb).generate('latest', new Date('2026-09-13T12:00:00Z'));

    expect(snapshot.items).toHaveProperty('tmdb:movie:70');
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:300');
  });

  it('rejects production snapshots below the configured minimum', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [movie(80, '单条电影', 50, [18])];
    await expect(new CatalogGenerator(tmdb).generate('popular')).rejects.toThrow('minimum is 20');
  });
});

function movie(id: number, title: string, popularity: number, genreIds: number[]): TmdbListItem {
  return {
    id,
    title,
    original_title: `${title} original`,
    popularity,
    genre_ids: genreIds,
    release_date: '2026-08-01',
    vote_average: 7.5,
    vote_count: 300,
  };
}

function tv(id: number, name: string, popularity: number, genreIds: number[]): TmdbListItem {
  return {
    id,
    name,
    original_name: `${name} original`,
    original_language: 'zh',
    popularity,
    genre_ids: genreIds,
    first_air_date: '2026-08-01',
    vote_average: 7.5,
    vote_count: 300,
  };
}

function returningTv(
  id: number,
  name: string,
  language: string,
  genreIds: number[],
  episodes: number,
  seasons: number,
): TmdbListItem {
  return {
    ...tv(id, name, 50, genreIds),
    original_language: language,
    first_air_date: '2010-01-01',
    number_of_episodes: episodes,
    number_of_seasons: seasons,
    last_episode_to_air: { air_date: '2026-09-12', season_number: seasons },
  };
}
