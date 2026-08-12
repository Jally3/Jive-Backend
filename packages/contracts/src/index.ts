import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

const ulid = monotonicFactory();
export type IdPrefix =
  | 'req'
  | 'ins'
  | 'vid'
  | 'ep'
  | 'src'
  | 'line'
  | 'sv'
  | 'se'
  | 'pb'
  | 'sync'
  | 'cat'
  | 'hist'
  | 'audit';
export const createId = (prefix: IdPrefix): string => `${prefix}_${ulid()}`;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});
export const videoListQuerySchema = paginationSchema.extend({
  category_id: z.string().max(64).optional(),
  sort: z.enum(['latest', 'title']).default('latest'),
});
export const searchQuerySchema = paginationSchema.extend({ q: z.string().trim().min(1).max(100) });
export const installationSchema = z.object({
  platform: z.enum(['android', 'ios']),
  app_version: z.string().min(1).max(32),
});
export const historySchema = z
  .object({
    position_seconds: z.number().int().min(0).max(604800),
    duration_seconds: z.number().int().min(0).max(604800),
    completed: z.boolean(),
    client_updated_at: z.iso.datetime(),
  })
  .refine((v) => v.duration_seconds === 0 || v.position_seconds <= v.duration_seconds * 1.1, {
    message: 'position_seconds exceeds duration_seconds',
    path: ['position_seconds'],
  });
export const playbackRequestSchema = z.object({ preferred_source: z.string().max(64).optional() });
export const playbackEventSchema = z.object({
  playback_id: z.string().startsWith('pb_'),
  event: z.enum([
    'requested',
    'resolved',
    'initialized',
    'first_frame',
    'progress',
    'completed',
    'error',
    'abandoned',
  ]),
  position_seconds: z.number().int().min(0).max(604800).optional(),
  error_code: z.string().max(100).optional(),
  occurred_at: z.iso.datetime(),
});

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}
export interface ApiEnvelope<T> {
  data: T | null;
  meta: Record<string, unknown>;
  error: ApiErrorBody | null;
  request_id: string;
}
export const success = <T>(
  data: T,
  requestId: string,
  meta: Record<string, unknown> = {},
): ApiEnvelope<T> => ({ data, meta, error: null, request_id: requestId });

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export interface InstallationResponse {
  installation_id: string;
  installation_token: string;
}
export interface VideoListItemResponse {
  id: string;
  title: string;
  poster_url?: string;
  category_name?: string;
  remarks?: string;
}
export interface PlaybackResponse {
  playback_id: string;
  url: string;
  format: 'hls' | 'dash' | 'mp4';
  source_code: string;
  line_code?: string;
  expires_at?: string;
  headers: Record<string, string>;
}

export function issueInstallationToken(id: string, secret: string): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${id}.${nonce}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function parseInstallationToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0]?.startsWith('ins_')) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2]!, 'base64url');
  } catch {
    return null;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? parts[0] : null;
}
export const tokenHash = (token: string, secret: string): string =>
  createHmac('sha256', secret).update(token).digest('hex');
