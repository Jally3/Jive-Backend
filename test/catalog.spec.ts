import { describe, expect, it } from 'vitest';
import { CatalogGenerator, type CatalogUpstream } from '../src/catalog.js';
import type { TmdbListItem } from '../src/tmdb-client.js';

class StubTmdb implements CatalogUpstream {
  movies: TmdbListItem[] = [];
  tv: TmdbListItem[] = [];
  onAir: TmdbListItem[] = [];
  details = new Map<number, TmdbListItem>();

  discoverMovies(): Promise<TmdbListItem[]> {
    return Promise.resolve(this.movies);
  }
  discoverTv(): Promise<TmdbListItem[]> {
    return Promise.resolve(this.tv);
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
}

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

    const snapshot = await new CatalogGenerator(tmdb).generate(
      'popular',
      new Date('2026-09-08T12:00:00Z'),
    );

    expect(snapshot.groups.all).toEqual(['tmdb:movie:2', 'tmdb:tv:6', 'tmdb:tv:5', 'tmdb:movie:1']);
    expect(snapshot.groups.animation).toEqual(['tmdb:movie:2']);
    expect(snapshot.groups.variety).toEqual(['tmdb:tv:6']);
    expect(snapshot.groups.movie).toEqual(['tmdb:movie:1']);
    expect(snapshot.groups.tv).toEqual(['tmdb:tv:5']);
    expect(snapshot.items).not.toHaveProperty('tmdb:movie:3');
  });

  it('filters English-language variety shows but keeps other English TV shows', async () => {
    const tmdb = new StubTmdb();
    tmdb.tv = [
      { ...tv(7, '英语综艺', 100, [10764]), original_language: 'en' },
      { ...tv(8, '韩语综艺', 90, [10764]), original_language: 'ko' },
      { ...tv(9, '英语剧集', 80, [18]), original_language: 'en' },
    ];

    const snapshot = await new CatalogGenerator(tmdb).generate('popular');

    expect(snapshot.groups.all).toEqual(['tmdb:tv:8', 'tmdb:tv:9']);
    expect(snapshot.groups.variety).toEqual(['tmdb:tv:8']);
    expect(snapshot.groups.tv).toEqual(['tmdb:tv:9']);
    expect(snapshot.items).not.toHaveProperty('tmdb:tv:7');
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

    const snapshot = await new CatalogGenerator(tmdb).generate(
      'latest',
      new Date('2026-09-08T12:00:00Z'),
    );
    expect(snapshot.items['tmdb:tv:20']).toMatchObject({
      sortDate: '2026-09-01',
      latestSeasonNumber: 4,
    });
  });

  it('orders top-rated items by rating and then vote count', async () => {
    const tmdb = new StubTmdb();
    tmdb.movies = [
      { ...movie(1, 'A', 1, [28]), vote_average: 8, vote_count: 300 },
      { ...movie(2, 'B', 1, [28]), vote_average: 8, vote_count: 500 },
      { ...movie(3, 'C', 1, [28]), vote_average: 6.9, vote_count: 5000 },
    ];
    const snapshot = await new CatalogGenerator(tmdb).generate('top_rated');
    expect(snapshot.groups.all).toEqual(['tmdb:movie:2', 'tmdb:movie:1']);
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
    popularity,
    genre_ids: genreIds,
    first_air_date: '2026-08-01',
    vote_average: 7.5,
    vote_count: 300,
  };
}
