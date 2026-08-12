import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertSafeUrl,
  type PlaybackFormat,
  SafeSourceClient,
  SourceError,
  type SourcePlayLine,
  type SourceRequestContext,
  type SourceVideo,
  type SourceVideoDetail,
  type SourceVideoPage,
  type VodSourceAdapter,
} from '../../../source-sdk/src/index.js';

const scalar = z.union([z.string(), z.number()]).transform(String);
const itemSchema = z
  .object({
    vod_id: scalar,
    vod_name: z.string().min(1),
    type_id: scalar.optional(),
    vod_pic: z.string().optional().default(''),
    vod_remarks: z.string().optional().default(''),
    vod_content: z.string().optional().default(''),
    vod_year: scalar.optional(),
    vod_status: z.string().optional(),
    vod_play_from: z.string().optional().default(''),
    vod_play_url: z.string().optional().default(''),
    vod_time: z.string().optional(),
  })
  .passthrough();
const responseSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    page: z.coerce.number().int().default(1),
    pagecount: z.coerce.number().int().min(0).default(1),
    total: z.coerce.number().int().min(0).default(0),
    list: z.array(itemSchema).default([]),
    class: z
      .array(z.object({ type_id: scalar, type_name: z.string(), type_pid: scalar.optional() }))
      .optional(),
  })
  .passthrough();

const cleanText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
const formatOf = (url: string): PlaybackFormat | null => {
  const path = new URL(url).pathname.toLowerCase();
  return path.endsWith('.m3u8')
    ? 'hls'
    : path.endsWith('.mpd')
      ? 'dash'
      : path.endsWith('.mp4')
        ? 'mp4'
        : null;
};
const parseEpisodeNo = (name: string): number | undefined => {
  const match = name.match(/(?:第)?(\d+)(?:集)?/);
  return match?.[1] ? Number(match[1]) : undefined;
};

export function parsePlayLines(playFrom: string, playUrl: string): SourcePlayLine[] {
  const names = playFrom.split('$$$');
  return playUrl
    .split('$$$')
    .map((group, lineIndex) => {
      const line = (names[lineIndex] || `line_${lineIndex + 1}`).trim();
      const seen = new Set<string>();
      const episodes = group.split('#').flatMap((entry, episodeIndex) => {
        const separator = entry.indexOf('$');
        if (separator <= 0) return [];
        const name = cleanText(entry.slice(0, separator));
        const url = entry.slice(separator + 1).trim();
        if (!name || !url || seen.has(url)) return [];
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || !formatOf(url)) return [];
        } catch {
          return [];
        }
        seen.add(url);
        const episodeNo = parseEpisodeNo(name);
        return [
          {
            key: createHash('sha256').update(`${name}\0${url}`).digest('hex').slice(0, 32),
            name,
            locator: { url },
            ...(episodeNo === undefined ? {} : { episodeNo }),
            sortOrder: episodeIndex,
          },
        ];
      });
      const formatHint = episodes[0]?.locator.url
        ? (formatOf(episodes[0].locator.url) ?? undefined)
        : undefined;
      return {
        code: line || `line_${lineIndex + 1}`,
        name: line || `线路 ${lineIndex + 1}`,
        episodes,
        ...(formatHint ? { formatHint } : {}),
      };
    })
    .filter((line) => line.episodes.length > 0);
}

const mapVideo = (item: z.infer<typeof itemSchema>): SourceVideo => ({
  sourceVideoId: item.vod_id,
  title: cleanText(item.vod_name),
  ...(item.type_id ? { categoryId: item.type_id } : {}),
  ...(item.vod_pic ? { posterUrl: item.vod_pic } : {}),
  ...(item.vod_remarks ? { remarks: cleanText(item.vod_remarks) } : {}),
  safeRaw: {
    vod_id: item.vod_id,
    vod_name: cleanText(item.vod_name),
    type_id: item.type_id,
    vod_pic: item.vod_pic,
    vod_remarks: cleanText(item.vod_remarks),
    vod_time: item.vod_time,
  },
});

export class StormAdapter implements VodSourceAdapter {
  readonly sourceCode = 'storm';
  readonly capabilities = {
    search: true,
    categories: true,
    incrementalSync: false,
    expiringPlaybackUrl: false,
    requiresPlaybackHeaders: false,
  } as const;
  constructor(
    private readonly client: SafeSourceClient,
    private readonly allowPrivate = false,
  ) {}
  async listCategories(context: SourceRequestContext) {
    const data = await this.client.getJson('?ac=list', responseSchema, context.signal);
    return (data.class ?? []).map((c) => ({
      sourceCategoryId: c.type_id,
      name: cleanText(c.type_name),
      ...(c.type_pid ? { parentId: c.type_pid } : {}),
    }));
  }
  async listVideos(
    input: { page: number; categoryId?: string; query?: string },
    context: SourceRequestContext,
  ): Promise<SourceVideoPage> {
    const params = new URLSearchParams({ ac: 'list', pg: String(input.page) });
    if (input.categoryId) params.set('t', input.categoryId);
    if (input.query) params.set('wd', input.query);
    const data = await this.client.getJson(`?${params}`, responseSchema, context.signal);
    return {
      items: data.list.map(mapVideo),
      page: data.page,
      pageCount: data.pagecount,
      total: data.total,
    };
  }
  async getVideoDetail(
    input: { sourceVideoId: string },
    context: SourceRequestContext,
  ): Promise<SourceVideoDetail> {
    const data = await this.client.getJson(
      `?ac=detail&ids=${encodeURIComponent(input.sourceVideoId)}`,
      responseSchema,
      context.signal,
    );
    const item = data.list[0];
    if (!item) throw new SourceError('invalid_response', 'Source video detail is empty', false);
    const lines = parsePlayLines(item.vod_play_from, item.vod_play_url).map((line) => ({
      ...line,
      episodes: line.episodes.map((episode) => ({
        ...episode,
        locator: {
          source_video_id: item.vod_id,
          line_code: line.code,
          source_episode_key: episode.key,
        },
      })),
    }));
    return {
      ...mapVideo(item),
      description: cleanText(item.vod_content),
      ...(item.vod_year && /^\d{4}$/.test(item.vod_year) ? { year: Number(item.vod_year) } : {}),
      ...(item.vod_status ? { status: cleanText(item.vod_status) } : {}),
      lines,
    };
  }
  async resolvePlayback(input: { locator: Record<string, string> }, context: SourceRequestContext) {
    const sourceVideoId = input.locator.source_video_id;
    const lineCode = input.locator.line_code;
    const episodeKey = input.locator.source_episode_key;
    if (!sourceVideoId || !lineCode || !episodeKey)
      throw new SourceError('invalid_url', 'Playback locator is missing', false);
    const data = await this.client.getJson(
      `?ac=detail&ids=${encodeURIComponent(sourceVideoId)}`,
      responseSchema,
      context.signal,
    );
    const item = data.list[0];
    if (!item) throw new SourceError('invalid_response', 'Source video detail is empty', false);
    const raw = parsePlayLines(item.vod_play_from, item.vod_play_url)
      .find((line) => line.code === lineCode)
      ?.episodes.find((episode) => episode.key === episodeKey)?.locator.url;
    if (!raw)
      throw new SourceError('invalid_response', 'Playback entry changed or disappeared', true);
    const url = await assertSafeUrl(raw, this.allowPrivate);
    const format = formatOf(url.toString());
    if (!format) throw new SourceError('invalid_url', 'Unsupported playback format', false);
    return [{ url: url.toString(), format }];
  }
  async healthCheck(context: SourceRequestContext) {
    const started = Date.now();
    try {
      await this.listVideos({ page: 1 }, context);
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : 'health check failed',
      };
    }
  }
}
