import { createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Environment } from '../packages/config/src/index.js';
import {
  createId,
  DomainError,
  issueInstallationToken,
  tokenHash,
} from '../packages/contracts/src/index.js';
import type { Database } from '../packages/database/src/index.js';
import {
  adminAuditLogs,
  categories,
  episodes,
  installations,
  playbackSessions,
  sourceCategories,
  sourceEpisodes,
  sourcePlayLines,
  sourceVideos,
  syncRuns,
  videos,
  vodSources,
  watchHistory,
} from '../packages/database/src/schema.js';
import { CacheService } from '../packages/cache/src/index.js';
import { playbackSwitches, sourceRequests } from '../packages/observability/src/index.js';
import {
  SourceError,
  SourceRegistry,
  assertSafeUrl,
  type ResolvedSourcePlayback,
  type SourceVideoDetail,
} from '../packages/source-sdk/src/index.js';

export const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 500);
const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicVideo = (row: any) => ({
  id: row.id,
  title: row.title,
  poster_url: row.posterUrl ?? undefined,
  backdrop_url: row.backdropUrl ?? undefined,
  description: row.description ?? undefined,
  category_id: row.categoryId ?? undefined,
  category_name: row.categoryName ?? undefined,
  year: row.year ?? undefined,
  status: row.status ?? undefined,
  remarks: row.remarks ?? undefined,
});

export class InstallationService {
  constructor(
    private readonly db: Database,
    private readonly env: Environment,
  ) {}
  async register(platform: string, appVersion: string) {
    const id = createId('ins');
    const token = issueInstallationToken(id, this.env.INSTALLATION_TOKEN_SECRET);
    await this.db.insert(installations).values({
      id,
      tokenHash: tokenHash(token, this.env.INSTALLATION_TOKEN_SECRET),
      platform,
      appVersion,
    });
    return { installation_id: id, installation_token: token };
  }
  async authenticate(header?: string): Promise<string> {
    if (!header?.startsWith('Bearer ')) throw new DomainError('UNAUTHORIZED', '安装凭证无效', 401);
    const token = header.slice(7);
    const parts = token.split('.');
    const id = parts[0];
    if (!id) throw new DomainError('UNAUTHORIZED', '安装凭证无效', 401);
    const rows = await this.db
      .select()
      .from(installations)
      .where(and(eq(installations.id, id), isNull(installations.revokedAt)))
      .limit(1);
    const record = rows[0];
    const hash = tokenHash(token, this.env.INSTALLATION_TOKEN_SECRET);
    if (
      !record ||
      record.tokenHash.length !== hash.length ||
      !timingSafeEqual(Buffer.from(record.tokenHash), Buffer.from(hash))
    )
      throw new DomainError('UNAUTHORIZED', '安装凭证无效', 401);
    await this.db
      .update(installations)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(installations.id, id));
    return id;
  }
}

export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheService,
  ) {}
  async listCategories() {
    const version = await this.cache.getVersion();
    const key = `categories:${version}`;
    const cached = await this.cache.getJson<{ schema_version: number; value: unknown[] }>(key);
    if (cached) return cached.value;
    const result = await this.db
      .select({
        id: categories.id,
        name: categories.name,
        parent_id: categories.parentId,
        sort_order: categories.sortOrder,
      })
      .from(categories)
      .where(eq(categories.enabled, true))
      .orderBy(asc(categories.sortOrder));
    await this.cache.setJson(key, result, 600);
    return result;
  }
  async list(input: {
    page: number;
    page_size: number;
    category_id?: string;
    sort: 'latest' | 'title';
    q?: string;
  }) {
    const where = and(
      eq(videos.enabled, true),
      input.category_id ? eq(videos.categoryId, input.category_id) : undefined,
      input.q ? ilike(videos.normalizedTitle, `%${normalize(input.q)}%`) : undefined,
    );
    const count =
      (
        await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(videos)
          .where(where)
      )[0]?.count ?? 0;
    const rows = await this.db
      .select({
        id: videos.id,
        title: videos.title,
        posterUrl: videos.posterUrl,
        remarks: videos.remarks,
        categoryId: videos.categoryId,
        categoryName: categories.name,
      })
      .from(videos)
      .leftJoin(categories, eq(videos.categoryId, categories.id))
      .where(where)
      .orderBy(input.sort === 'title' ? asc(videos.normalizedTitle) : desc(videos.updatedAt))
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    return {
      items: rows.map(publicVideo),
      pagination: {
        page: input.page,
        page_size: input.page_size,
        total: count,
        total_pages: Math.ceil(count / input.page_size),
      },
    };
  }
  async detail(videoId: string) {
    const rows = await this.db
      .select({
        id: videos.id,
        title: videos.title,
        posterUrl: videos.posterUrl,
        backdropUrl: videos.backdropUrl,
        description: videos.description,
        categoryId: videos.categoryId,
        categoryName: categories.name,
        year: videos.year,
        status: videos.status,
        remarks: videos.remarks,
      })
      .from(videos)
      .leftJoin(categories, eq(videos.categoryId, categories.id))
      .where(and(eq(videos.id, videoId), eq(videos.enabled, true)))
      .limit(1);
    const video = rows[0];
    if (!video) throw new DomainError('VIDEO_NOT_FOUND', '视频不存在或已下架', 404);
    const episodeRows = await this.db
      .select({
        id: episodes.id,
        name: episodes.name,
        episode_no: episodes.episodeNo,
        sort_order: episodes.sortOrder,
      })
      .from(episodes)
      .where(and(eq(episodes.videoId, videoId), eq(episodes.enabled, true)))
      .orderBy(asc(episodes.sortOrder));
    const sources = await this.db
      .selectDistinct({ code: vodSources.code, name: vodSources.name })
      .from(sourceEpisodes)
      .innerJoin(sourceVideos, eq(sourceEpisodes.sourceVideoId, sourceVideos.id))
      .innerJoin(vodSources, eq(sourceVideos.sourceId, vodSources.id))
      .innerJoin(sourcePlayLines, eq(sourceEpisodes.playLineId, sourcePlayLines.id))
      .where(
        and(
          eq(sourceVideos.videoId, videoId),
          eq(sourceEpisodes.enabled, true),
          eq(sourceVideos.enabled, true),
          eq(vodSources.enabled, true),
          eq(sourcePlayLines.enabled, true),
        ),
      );
    return {
      ...publicVideo(video),
      episodes: episodeRows,
      available_sources: sources.map((s) => ({ ...s, available: true })),
    };
  }
}

export class HistoryService {
  constructor(private readonly db: Database) {}
  async list(ownerId: string, page: number, pageSize: number) {
    const rows = await this.db
      .select({
        video_id: watchHistory.videoId,
        episode_id: watchHistory.episodeId,
        position_seconds: watchHistory.positionSeconds,
        duration_seconds: watchHistory.durationSeconds,
        completed: watchHistory.completed,
        updated_at: watchHistory.updatedAt,
        title: videos.title,
        episode_name: episodes.name,
      })
      .from(watchHistory)
      .innerJoin(videos, eq(watchHistory.videoId, videos.id))
      .innerJoin(episodes, eq(watchHistory.episodeId, episodes.id))
      .where(and(eq(watchHistory.ownerType, 'installation'), eq(watchHistory.ownerId, ownerId)))
      .orderBy(desc(watchHistory.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return rows;
  }
  async put(
    ownerId: string,
    videoId: string,
    episodeId: string,
    input: {
      position_seconds: number;
      duration_seconds: number;
      completed: boolean;
      client_updated_at: string;
    },
  ) {
    const membership = await this.db
      .select({ id: episodes.id })
      .from(episodes)
      .innerJoin(videos, eq(episodes.videoId, videos.id))
      .where(
        and(
          eq(episodes.id, episodeId),
          eq(episodes.videoId, videoId),
          eq(episodes.enabled, true),
          eq(videos.enabled, true),
        ),
      )
      .limit(1);
    if (!membership[0]) throw new DomainError('EPISODE_NOT_FOUND', '剧集不存在或已下架', 404);
    const clientUpdatedAt = new Date(input.client_updated_at);
    const id = createId('hist');
    await this.db
      .insert(watchHistory)
      .values({
        id,
        ownerType: 'installation',
        ownerId,
        videoId,
        episodeId,
        positionSeconds: input.position_seconds,
        durationSeconds: input.duration_seconds,
        completed: input.completed,
        clientUpdatedAt,
      })
      .onConflictDoUpdate({
        target: [
          watchHistory.ownerType,
          watchHistory.ownerId,
          watchHistory.videoId,
          watchHistory.episodeId,
        ],
        set: {
          positionSeconds: sql`CASE WHEN ${watchHistory.clientUpdatedAt} <= excluded.client_updated_at THEN excluded.position_seconds ELSE ${watchHistory.positionSeconds} END`,
          durationSeconds: sql`CASE WHEN ${watchHistory.clientUpdatedAt} <= excluded.client_updated_at THEN excluded.duration_seconds ELSE ${watchHistory.durationSeconds} END`,
          completed: sql`CASE WHEN ${watchHistory.clientUpdatedAt} <= excluded.client_updated_at THEN excluded.completed ELSE ${watchHistory.completed} END`,
          clientUpdatedAt: sql`greatest(${watchHistory.clientUpdatedAt}, excluded.client_updated_at)`,
          updatedAt: new Date(),
        },
      });
    return { updated: true };
  }
}

type Candidate = {
  sourceId: string;
  sourceCode: string;
  adapterName: string;
  lineId: string;
  lineCode: string;
  locator: Record<string, string>;
};
export class PlaybackService {
  constructor(
    private readonly db: Database,
    private readonly registry: SourceRegistry,
    private readonly cache: CacheService,
    private readonly env: Environment,
  ) {}
  async resolve(ownerId: string, videoId: string, episodeId: string, preferred?: string) {
    const candidates = (await this.db
      .select({
        sourceId: vodSources.id,
        sourceCode: vodSources.code,
        adapterName: vodSources.adapterName,
        lineId: sourcePlayLines.id,
        lineCode: sourcePlayLines.lineCode,
        locator: sourceEpisodes.sourceLocator,
      })
      .from(sourceEpisodes)
      .innerJoin(sourceVideos, eq(sourceEpisodes.sourceVideoId, sourceVideos.id))
      .innerJoin(vodSources, eq(sourceVideos.sourceId, vodSources.id))
      .innerJoin(sourcePlayLines, eq(sourceEpisodes.playLineId, sourcePlayLines.id))
      .innerJoin(episodes, eq(sourceEpisodes.episodeId, episodes.id))
      .innerJoin(videos, eq(episodes.videoId, videos.id))
      .where(
        and(
          eq(videos.id, videoId),
          eq(episodes.id, episodeId),
          eq(videos.enabled, true),
          eq(episodes.enabled, true),
          eq(sourceEpisodes.enabled, true),
          eq(sourceVideos.enabled, true),
          eq(vodSources.enabled, true),
          eq(sourcePlayLines.enabled, true),
          or(
            eq(vodSources.healthStatus, 'healthy'),
            eq(vodSources.healthStatus, 'degraded'),
            eq(vodSources.healthStatus, 'unknown'),
          ),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${vodSources.code} = ${preferred ?? ''} THEN 0 ELSE 1 END`,
        asc(vodSources.priority),
        asc(sourcePlayLines.priority),
      )
      .limit(this.env.PLAYBACK_MAX_CANDIDATES)) as Candidate[];
    if (!candidates.length)
      throw new DomainError('PLAYBACK_UNAVAILABLE', '当前暂无可用播放源', 503, true);
    const deadline = Date.now() + this.env.PLAYBACK_TIMEOUT_MS;
    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      if (Date.now() >= deadline) break;
      if (index > 0) playbackSwitches.inc();
      const key = `playback:${episodeId}:${candidate.sourceCode}:${candidate.lineCode}`;
      const wrapped = await this.cache.getJson<{
        schema_version: number;
        value: ResolvedSourcePlayback;
      }>(key);
      let resolved = wrapped?.value;
      if (resolved?.expiresAt && typeof resolved.expiresAt === 'string') {
        resolved = { ...resolved, expiresAt: new Date(resolved.expiresAt) };
      }
      try {
        if (!resolved) {
          const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
          const options = await this.registry
            .get(candidate.adapterName)
            .resolvePlayback(
              { locator: candidate.locator },
              { requestId: createId('req'), signal: timeout },
            );
          resolved = options[0];
          if (!resolved) throw new SourceError('invalid_response', 'No playback result', true);
          await assertSafeUrl(resolved.url, this.env.SOURCE_ALLOW_PRIVATE_HOSTS);
          const now = Date.now();
          const expiryTtl = resolved.expiresAt
            ? Math.floor((resolved.expiresAt.getTime() - now - 15_000) / 1000)
            : this.env.PLAYBACK_CACHE_TTL_SECONDS;
          if (expiryTtl <= 0)
            throw new SourceError('invalid_url', 'Playback URL expires too soon', true);
          await this.cache.setJson(
            key,
            resolved,
            Math.min(this.env.PLAYBACK_CACHE_TTL_SECONDS, expiryTtl),
          );
        }
        const playbackId = createId('pb');
        await this.db.insert(playbackSessions).values({
          id: playbackId,
          ownerId,
          videoId,
          episodeId,
          sourceId: candidate.sourceId,
          playLineId: candidate.lineId,
          status: 'resolved',
          resolvedAt: new Date(),
          expiresAt: resolved.expiresAt,
        });
        sourceRequests.inc({ source: candidate.sourceCode, result: 'success' });
        return {
          playback_id: playbackId,
          url: resolved.url,
          format: resolved.format,
          source_code: candidate.sourceCode,
          line_code: candidate.lineCode,
          expires_at: resolved.expiresAt?.toISOString(),
          headers: resolved.headers ?? {},
        };
      } catch (error) {
        lastError = error;
        sourceRequests.inc({ source: candidate.sourceCode, result: 'failure' });
      }
    }
    void lastError;
    throw new DomainError('PLAYBACK_UNAVAILABLE', '当前暂无可用播放源', 503, true);
  }
  async event(ownerId: string, input: { playback_id: string; event: string; occurred_at: string }) {
    const rows = await this.db
      .select({
        id: playbackSessions.id,
        ownerId: playbackSessions.ownerId,
        lastEventAt: playbackSessions.lastEventAt,
      })
      .from(playbackSessions)
      .where(eq(playbackSessions.id, input.playback_id))
      .limit(1);
    const session = rows[0];
    if (!session || session.ownerId !== ownerId)
      throw new DomainError('UNAUTHORIZED', '播放会话无效', 401);
    const occurredAt = new Date(input.occurred_at);
    if (!session.lastEventAt || occurredAt >= session.lastEventAt)
      await this.db
        .update(playbackSessions)
        .set({
          status: ['completed', 'error', 'abandoned'].includes(input.event)
            ? input.event
            : 'active',
          lastEventAt: occurredAt,
          lastEventType: input.event,
          firstEventAt: session.lastEventAt ?? occurredAt,
          updatedAt: new Date(),
        })
        .where(eq(playbackSessions.id, input.playback_id));
    return { accepted: true };
  }
}

export interface SyncJob {
  sourceId: string;
  sourceCode: string;
  adapterName: string;
  runId: string;
  kind: 'full' | 'incremental';
}
export class QueueService {
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly env: Environment) {
    this.connection = new Redis(env.QUEUE_REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', () => undefined);
  }
  private queue(source: string) {
    let q = this.queues.get(source);
    if (!q) {
      q = new Queue(`vod-sync:${source}`, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 500,
          removeOnFail: 1000,
        },
      });
      this.queues.set(source, q);
    }
    return q;
  }
  async enqueue(job: SyncJob) {
    await this.queue(job.sourceCode).add(
      job.kind === 'full' ? 'source.full-sync' : 'source.incremental-sync',
      job,
      { jobId: `${job.sourceCode}-${job.kind}-${job.runId}` },
    );
  }
  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }
}

export class SyncService {
  constructor(
    private readonly db: Database,
    private readonly registry: SourceRegistry,
    private readonly cache: CacheService,
  ) {}
  async run(job: SyncJob): Promise<void> {
    const adapter = this.registry.get(job.adapterName);
    await this.db
      .update(syncRuns)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncRuns.id, job.runId));
    let fetched = 0,
      changed = 0,
      skipped = 0,
      failed = 0;
    const errors: string[] = [];
    try {
      if (adapter.capabilities.categories)
        for (const [order, item] of (
          await adapter.listCategories({ requestId: job.runId })
        ).entries()) {
          const id = `cat_${sha256(`${job.sourceId}:${item.sourceCategoryId}`).slice(0, 26).toUpperCase()}`;
          await this.db
            .insert(categories)
            .values({ id, name: item.name, sortOrder: order })
            .onConflictDoUpdate({
              target: categories.id,
              set: { name: item.name, updatedAt: new Date() },
            });
          await this.db
            .insert(sourceCategories)
            .values({
              sourceId: job.sourceId,
              sourceCategoryId: item.sourceCategoryId,
              sourceCategoryName: item.name,
              categoryId: id,
            })
            .onConflictDoUpdate({
              target: [sourceCategories.sourceId, sourceCategories.sourceCategoryId],
              set: { sourceCategoryName: item.name, categoryId: id, updatedAt: new Date() },
            });
        }
      let page = 1,
        pageCount = 1;
      do {
        const result = await adapter.listVideos({ page }, { requestId: job.runId });
        pageCount = result.pageCount;
        fetched += result.items.length;
        for (const item of result.items)
          try {
            const hash = sha256(item.safeRaw);
            const existing = await this.db
              .select({ id: sourceVideos.id, contentHash: sourceVideos.contentHash })
              .from(sourceVideos)
              .where(
                and(
                  eq(sourceVideos.sourceId, job.sourceId),
                  eq(sourceVideos.sourceVideoId, item.sourceVideoId),
                ),
              )
              .limit(1);
            if (existing[0]?.contentHash === hash) {
              await this.db
                .update(sourceVideos)
                .set({ lastSeenRunId: job.runId, lastSyncedAt: new Date(), missingCount: 0 })
                .where(eq(sourceVideos.id, existing[0].id));
              skipped++;
              continue;
            }
            const detail = await adapter.getVideoDetail(
              { sourceVideoId: item.sourceVideoId },
              { requestId: job.runId },
            );
            await this.upsertDetail(job, detail, hash);
            changed++;
          } catch (error) {
            failed++;
            errors.push(
              error instanceof Error ? error.message.slice(0, 300) : 'unknown item failure',
            );
          }
        page++;
        await this.db
          .update(syncRuns)
          .set({
            cursor: { next_page: page, page_count: pageCount },
            fetchedCount: fetched,
            changedCount: changed,
            skippedCount: skipped,
            failedCount: failed,
            errorSummary: { errors: errors.slice(-20) },
            updatedAt: new Date(),
          })
          .where(eq(syncRuns.id, job.runId));
      } while (page <= pageCount);
      if (job.kind === 'full' && failed === 0)
        await this.db
          .update(sourceVideos)
          .set({
            missingCount: sql`${sourceVideos.missingCount} + 1`,
            enabled: sql`CASE WHEN ${sourceVideos.missingCount} + 1 >= 2 THEN false ELSE ${sourceVideos.enabled} END`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sourceVideos.sourceId, job.sourceId),
              or(
                sql`${sourceVideos.lastSeenRunId} IS NULL`,
                sql`${sourceVideos.lastSeenRunId} <> ${job.runId}`,
              ),
            ),
          );
      await this.db
        .update(syncRuns)
        .set({
          status: failed ? 'partial' : 'completed',
          finishedAt: new Date(),
          fetchedCount: fetched,
          changedCount: changed,
          skippedCount: skipped,
          failedCount: failed,
          errorSummary: { errors: errors.slice(-20) },
          updatedAt: new Date(),
        })
        .where(eq(syncRuns.id, job.runId));
      await this.cache.bumpVersion();
    } catch (error) {
      await this.db
        .update(syncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: {
            message: error instanceof Error ? error.message.slice(0, 500) : 'sync failed',
          },
          updatedAt: new Date(),
        })
        .where(eq(syncRuns.id, job.runId));
      throw error;
    }
  }
  private async upsertDetail(job: SyncJob, detail: SourceVideoDetail, hash: string) {
    await this.db.transaction(async (tx) => {
      const mapping = await tx
        .select({ id: sourceVideos.id, videoId: sourceVideos.videoId })
        .from(sourceVideos)
        .where(
          and(
            eq(sourceVideos.sourceId, job.sourceId),
            eq(sourceVideos.sourceVideoId, detail.sourceVideoId),
          ),
        )
        .limit(1);
      const videoId = mapping[0]?.videoId ?? createId('vid');
      const sourceVideoPk = mapping[0]?.id ?? createId('sv');
      const cat = detail.categoryId
        ? (
            await tx
              .select({ categoryId: sourceCategories.categoryId })
              .from(sourceCategories)
              .where(
                and(
                  eq(sourceCategories.sourceId, job.sourceId),
                  eq(sourceCategories.sourceCategoryId, detail.categoryId),
                ),
              )
              .limit(1)
          )[0]?.categoryId
        : undefined;
      await tx
        .insert(videos)
        .values({
          id: videoId,
          title: detail.title,
          normalizedTitle: normalize(detail.title),
          posterUrl: detail.posterUrl,
          description: detail.description,
          categoryId: cat,
          year: detail.year,
          status: detail.status,
          remarks: detail.remarks,
        })
        .onConflictDoUpdate({
          target: videos.id,
          set: {
            title: detail.title,
            normalizedTitle: normalize(detail.title),
            posterUrl: detail.posterUrl,
            description: detail.description,
            categoryId: cat,
            year: detail.year,
            status: detail.status,
            remarks: detail.remarks,
            enabled: true,
            updatedAt: new Date(),
          },
        });
      await tx
        .insert(sourceVideos)
        .values({
          id: sourceVideoPk,
          videoId,
          sourceId: job.sourceId,
          sourceVideoId: detail.sourceVideoId,
          sourceCategoryId: detail.categoryId,
          contentHash: hash,
          rawPayload: detail.safeRaw,
          lastSeenRunId: job.runId,
          missingCount: 0,
        })
        .onConflictDoUpdate({
          target: [sourceVideos.sourceId, sourceVideos.sourceVideoId],
          set: {
            contentHash: hash,
            rawPayload: detail.safeRaw,
            lastSeenRunId: job.runId,
            lastSyncedAt: new Date(),
            missingCount: 0,
            enabled: true,
            updatedAt: new Date(),
          },
        });
      for (const [lineOrder, line] of detail.lines.entries()) {
        const lineId = `line_${sha256(`${job.sourceId}:${line.code}`).slice(0, 25).toUpperCase()}`;
        await tx
          .insert(sourcePlayLines)
          .values({
            id: lineId,
            sourceId: job.sourceId,
            lineCode: line.code,
            lineName: line.name,
            formatHint: line.formatHint,
            priority: lineOrder,
          })
          .onConflictDoUpdate({
            target: [sourcePlayLines.sourceId, sourcePlayLines.lineCode],
            set: { lineName: line.name, formatHint: line.formatHint, updatedAt: new Date() },
          });
        for (const [sortOrder, episode] of line.episodes.entries()) {
          const normalizedName = normalize(episode.name);
          let ep = (
            await tx
              .select({ id: episodes.id })
              .from(episodes)
              .where(
                and(eq(episodes.videoId, videoId), eq(episodes.normalizedName, normalizedName)),
              )
              .limit(1)
          )[0];
          if (!ep) {
            ep = { id: createId('ep') };
            await tx.insert(episodes).values({
              id: ep.id,
              videoId,
              name: episode.name,
              normalizedName,
              episodeNo: episode.episodeNo,
              sortOrder,
            });
          }
          await tx
            .insert(sourceEpisodes)
            .values({
              id: createId('se'),
              episodeId: ep.id,
              sourceVideoId: sourceVideoPk,
              playLineId: lineId,
              sourceEpisodeKey: episode.key,
              sourceEpisodeName: episode.name,
              sourceLocator: episode.locator,
              lastSeenRunId: job.runId,
            })
            .onConflictDoUpdate({
              target: [
                sourceEpisodes.sourceVideoId,
                sourceEpisodes.playLineId,
                sourceEpisodes.sourceEpisodeKey,
              ],
              set: {
                episodeId: ep.id,
                sourceLocator: episode.locator,
                lastSeenRunId: job.runId,
                lastSyncedAt: new Date(),
                enabled: true,
                updatedAt: new Date(),
              },
            });
        }
      }
    });
  }
}

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly queue: QueueService,
    private readonly cache: CacheService,
    private readonly registry: SourceRegistry,
  ) {}
  authenticate(header: string | undefined, token: string) {
    const actual = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (actual.length !== token.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(token)))
      throw new DomainError('UNAUTHORIZED', 'Admin 凭证无效', 401);
  }
  sources() {
    return this.db
      .select({
        id: vodSources.id,
        code: vodSources.code,
        name: vodSources.name,
        adapter_name: vodSources.adapterName,
        base_url: vodSources.baseUrl,
        priority: vodSources.priority,
        enabled: vodSources.enabled,
        health_status: vodSources.healthStatus,
        last_health_at: vodSources.lastHealthAt,
      })
      .from(vodSources)
      .orderBy(asc(vodSources.priority));
  }
  async patchSource(
    id: string,
    input: { enabled?: boolean; priority?: number; name?: string },
    requestId: string,
  ) {
    const before = (
      await this.db.select().from(vodSources).where(eq(vodSources.id, id)).limit(1)
    )[0];
    if (!before) throw new DomainError('SOURCE_UNAVAILABLE', '来源不存在', 404);
    const after = { ...before, ...input, updatedAt: new Date() };
    await this.db.transaction(async (tx) => {
      await tx.update(vodSources).set(input).where(eq(vodSources.id, id));
      await tx.insert(adminAuditLogs).values({
        id: createId('audit'),
        actorType: 'admin_token',
        actorId: 'admin',
        action: 'source.update',
        targetType: 'vod_source',
        targetId: id,
        requestId,
        before,
        after,
      });
    });
    await this.cache.bumpVersion();
    return { updated: true };
  }
  async patchLine(id: string, input: { enabled?: boolean; priority?: number }, requestId: string) {
    const before = (
      await this.db.select().from(sourcePlayLines).where(eq(sourcePlayLines.id, id)).limit(1)
    )[0];
    if (!before) throw new DomainError('SOURCE_UNAVAILABLE', '线路不存在', 404);
    await this.db.transaction(async (tx) => {
      await tx.update(sourcePlayLines).set(input).where(eq(sourcePlayLines.id, id));
      await tx.insert(adminAuditLogs).values({
        id: createId('audit'),
        actorType: 'admin_token',
        actorId: 'admin',
        action: 'line.update',
        targetType: 'source_play_line',
        targetId: id,
        requestId,
        before,
        after: { ...before, ...input },
      });
    });
    await this.cache.bumpVersion();
    return { updated: true };
  }
  async addSource(
    input: { code: string; name: string; adapter_name: string; base_url: string; priority: number },
    requestId: string,
  ) {
    const url = await assertSafeUrl(input.base_url);
    this.registry.get(input.adapter_name);
    const id = createId('src');
    await this.db.transaction(async (tx) => {
      await tx.insert(vodSources).values({
        id,
        code: input.code,
        name: input.name,
        adapterName: input.adapter_name,
        baseUrl: url.toString(),
        priority: input.priority,
      });
      await tx.insert(adminAuditLogs).values({
        id: createId('audit'),
        actorType: 'admin_token',
        actorId: 'admin',
        action: 'source.create',
        targetType: 'vod_source',
        targetId: id,
        requestId,
        after: { ...input, base_url: url.origin },
      });
    });
    return { id };
  }
  async trigger(sourceId: string, kind: 'full' | 'incremental') {
    const source = (
      await this.db
        .select()
        .from(vodSources)
        .where(and(eq(vodSources.id, sourceId), eq(vodSources.enabled, true)))
        .limit(1)
    )[0];
    if (!source) throw new DomainError('SOURCE_UNAVAILABLE', '来源不存在或未启用', 404);
    const active = await this.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.sourceId, sourceId), inArray(syncRuns.status, ['pending', 'running'])))
      .limit(1);
    if (active[0]) return { sync_run_id: active[0].id, deduplicated: true };
    const runId = createId('sync');
    await this.db
      .insert(syncRuns)
      .values({ id: runId, sourceId, triggerType: `admin_${kind}`, status: 'pending' });
    try {
      await this.queue.enqueue({
        sourceId,
        sourceCode: source.code,
        adapterName: source.adapterName,
        runId,
        kind,
      });
    } catch (error) {
      await this.db
        .update(syncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: { message: 'queue enqueue failed' },
        })
        .where(eq(syncRuns.id, runId));
      throw error;
    }
    return { sync_run_id: runId, deduplicated: false };
  }
  runs(sourceId?: string) {
    return this.db
      .select()
      .from(syncRuns)
      .where(sourceId ? eq(syncRuns.sourceId, sourceId) : undefined)
      .orderBy(desc(syncRuns.createdAt))
      .limit(100);
  }
  async toggleVideo(id: string, enabled: boolean, requestId: string) {
    await this.db.transaction(async (tx) => {
      const before = (await tx.select().from(videos).where(eq(videos.id, id)).limit(1))[0];
      if (!before) throw new DomainError('VIDEO_NOT_FOUND', '视频不存在', 404);
      await tx.update(videos).set({ enabled, updatedAt: new Date() }).where(eq(videos.id, id));
      await tx.insert(adminAuditLogs).values({
        id: createId('audit'),
        actorType: 'admin_token',
        actorId: 'admin',
        action: enabled ? 'video.restore' : 'video.disable',
        targetType: 'video',
        targetId: id,
        requestId,
        before,
        after: { ...before, enabled },
      });
    });
    await this.cache.bumpVersion();
    return { updated: true };
  }
  async remap(sourceVideoId: string, videoId: string, requestId: string) {
    await this.db.transaction(async (tx) => {
      const before = (
        await tx.select().from(sourceVideos).where(eq(sourceVideos.id, sourceVideoId)).limit(1)
      )[0];
      const target = (
        await tx.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1)
      )[0];
      if (!before || !target) throw new DomainError('VIDEO_NOT_FOUND', '映射对象不存在', 404);
      await tx
        .update(sourceVideos)
        .set({ videoId, updatedAt: new Date() })
        .where(eq(sourceVideos.id, sourceVideoId));
      await tx.insert(adminAuditLogs).values({
        id: createId('audit'),
        actorType: 'admin_token',
        actorId: 'admin',
        action: 'mapping.remap',
        targetType: 'source_video',
        targetId: sourceVideoId,
        requestId,
        before: { video_id: before.videoId },
        after: { video_id: videoId },
      });
    });
    await this.cache.bumpVersion();
    return { updated: true };
  }
}

export class HealthService {
  constructor(
    private readonly pool: Pool,
    private readonly cache: CacheService,
  ) {}
  live() {
    return { status: 'ok' };
  }
  async ready() {
    try {
      await this.pool.query('select 1');
      let cache = 'ok';
      try {
        await this.cache.redis.ping();
      } catch {
        cache = 'degraded';
      }
      return { status: 'ok', postgres: 'ok', cache };
    } catch {
      throw new DomainError('INTERNAL_ERROR', '服务尚未就绪', 503, true);
    }
  }
}
