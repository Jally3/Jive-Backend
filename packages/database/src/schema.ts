import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
export const healthStatus = pgEnum('health_status', ['healthy', 'degraded', 'offline', 'unknown']);
export const syncStatus = pgEnum('sync_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'partial',
]);

export const vodSources = pgTable(
  'vod_sources',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    adapterName: text('adapter_name').notNull(),
    baseUrl: text('base_url').notNull(),
    config: jsonb('config_jsonb').notNull().default({}),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    healthStatus: healthStatus('health_status').notNull().default('unknown'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('vod_sources_code_uidx').on(t.code)],
);
export const sourcePlayLines = pgTable(
  'source_play_lines',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => vodSources.id),
    lineCode: text('line_code').notNull(),
    lineName: text('line_name').notNull(),
    formatHint: text('format_hint'),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    healthStatus: healthStatus('health_status').notNull().default('unknown'),
    ...timestamps,
  },
  (t) => [uniqueIndex('source_play_lines_source_code_uidx').on(t.sourceId, t.lineCode)],
);
export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps,
});
export const sourceCategories = pgTable(
  'source_categories',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => vodSources.id),
    sourceCategoryId: text('source_category_id').notNull(),
    sourceCategoryName: text('source_category_name').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    ...timestamps,
  },
  (t) => [uniqueIndex('source_categories_source_category_uidx').on(t.sourceId, t.sourceCategoryId)],
);
export const videos = pgTable(
  'videos',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    normalizedTitle: text('normalized_title').notNull(),
    posterUrl: text('poster_url'),
    backdropUrl: text('backdrop_url'),
    description: text('description'),
    categoryId: text('category_id').references(() => categories.id),
    year: integer('year'),
    status: text('status'),
    remarks: text('remarks'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('videos_normalized_title_idx').on(t.normalizedTitle),
    index('videos_category_enabled_updated_idx').on(t.categoryId, t.enabled, t.updatedAt),
  ],
);
export const sourceVideos = pgTable(
  'source_videos',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id),
    sourceId: text('source_id')
      .notNull()
      .references(() => vodSources.id),
    sourceVideoId: text('source_video_id').notNull(),
    sourceCategoryId: text('source_category_id'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    contentHash: text('content_hash').notNull(),
    rawPayload: jsonb('raw_payload_jsonb').notNull().default({}),
    lastSeenRunId: text('last_seen_run_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    missingCount: integer('missing_count').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('source_videos_source_video_uidx').on(t.sourceId, t.sourceVideoId),
    index('source_videos_seen_idx').on(t.sourceId, t.lastSeenRunId),
  ],
);
export const episodes = pgTable(
  'episodes',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    episodeNo: integer('episode_no'),
    sortOrder: integer('sort_order').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('episodes_video_enabled_sort_idx').on(t.videoId, t.enabled, t.sortOrder)],
);
export const sourceEpisodes = pgTable(
  'source_episodes',
  {
    id: text('id').primaryKey(),
    episodeId: text('episode_id')
      .notNull()
      .references(() => episodes.id),
    sourceVideoId: text('source_video_id')
      .notNull()
      .references(() => sourceVideos.id),
    playLineId: text('play_line_id')
      .notNull()
      .references(() => sourcePlayLines.id),
    sourceEpisodeKey: text('source_episode_key').notNull(),
    sourceEpisodeName: text('source_episode_name').notNull(),
    sourceLocator: jsonb('source_locator_jsonb').notNull(),
    lastSeenRunId: text('last_seen_run_id'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('source_episodes_mapping_uidx').on(
      t.sourceVideoId,
      t.playLineId,
      t.sourceEpisodeKey,
    ),
    index('source_episodes_episode_enabled_idx').on(t.episodeId, t.enabled),
  ],
);
export const installations = pgTable(
  'installations',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    tokenVersion: integer('token_version').notNull().default(1),
    platform: text('platform').notNull(),
    appVersion: text('app_version').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('installations_token_hash_uidx').on(t.tokenHash)],
);
export const watchHistory = pgTable(
  'watch_history',
  {
    id: text('id').primaryKey(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => installations.id),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id),
    episodeId: text('episode_id')
      .notNull()
      .references(() => episodes.id),
    positionSeconds: integer('position_seconds').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    completed: boolean('completed').notNull(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('watch_history_owner_video_episode_uidx').on(
      t.ownerType,
      t.ownerId,
      t.videoId,
      t.episodeId,
    ),
    index('watch_history_owner_updated_idx').on(t.ownerType, t.ownerId, t.updatedAt),
  ],
);
export const playbackSessions = pgTable('playback_sessions', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => installations.id),
  videoId: text('video_id')
    .notNull()
    .references(() => videos.id),
  episodeId: text('episode_id')
    .notNull()
    .references(() => episodes.id),
  sourceId: text('source_id')
    .notNull()
    .references(() => vodSources.id),
  playLineId: text('play_line_id')
    .notNull()
    .references(() => sourcePlayLines.id),
  status: text('status').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  firstEventAt: timestamp('first_event_at', { withTimezone: true }),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  lastEventType: text('last_event_type'),
  ...timestamps,
});
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => vodSources.id),
    triggerType: text('trigger_type').notNull(),
    status: syncStatus('status').notNull().default('pending'),
    cursor: jsonb('cursor_jsonb').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    fetchedCount: integer('fetched_count').notNull().default(0),
    changedCount: integer('changed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errorSummary: jsonb('error_summary_jsonb').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('sync_runs_source_started_idx').on(t.sourceId, t.startedAt)],
);
export const adminAuditLogs = pgTable('admin_audit_logs', {
  id: text('id').primaryKey(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  requestId: text('request_id').notNull(),
  before: jsonb('before_jsonb'),
  after: jsonb('after_jsonb'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const catalogState = pgTable(
  'catalog_state',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('catalog_state_singleton_uidx')
      .on(t.singleton)
      .where(sql`${t.singleton} = true`),
  ],
);
