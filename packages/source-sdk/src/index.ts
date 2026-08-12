import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'undici';
import { z } from 'zod';

export interface SourceRequestContext {
  requestId: string;
  signal?: AbortSignal;
}
export interface SourceCategory {
  sourceCategoryId: string;
  name: string;
  parentId?: string;
}
export interface SourceVideo {
  sourceVideoId: string;
  title: string;
  categoryId?: string;
  posterUrl?: string;
  remarks?: string;
  sourceUpdatedAt?: Date;
  safeRaw: Record<string, unknown>;
}
export interface SourceEpisode {
  key: string;
  name: string;
  locator: Record<string, string>;
  episodeNo?: number;
}
export interface SourcePlayLine {
  code: string;
  name: string;
  formatHint?: PlaybackFormat;
  episodes: SourceEpisode[];
}
export interface SourceVideoDetail extends SourceVideo {
  description?: string;
  year?: number;
  status?: string;
  lines: SourcePlayLine[];
}
export interface SourceVideoPage {
  items: SourceVideo[];
  page: number;
  pageCount: number;
  total: number;
}
export type PlaybackFormat = 'hls' | 'dash' | 'mp4';
export interface ResolvedSourcePlayback {
  url: string;
  format: PlaybackFormat;
  headers?: Record<string, string>;
  expiresAt?: Date;
}
export interface SourceHealthResult {
  healthy: boolean;
  latencyMs: number;
  message?: string;
}
export interface SourceCapabilities {
  search: boolean;
  categories: boolean;
  incrementalSync: boolean;
  expiringPlaybackUrl: boolean;
  requiresPlaybackHeaders: boolean;
}
export interface VodSourceAdapter {
  readonly sourceCode: string;
  readonly capabilities: SourceCapabilities;
  listCategories(context: SourceRequestContext): Promise<SourceCategory[]>;
  listVideos(
    input: { page: number; categoryId?: string; query?: string },
    context: SourceRequestContext,
  ): Promise<SourceVideoPage>;
  getVideoDetail(
    input: { sourceVideoId: string },
    context: SourceRequestContext,
  ): Promise<SourceVideoDetail>;
  resolvePlayback(
    input: { locator: Record<string, string> },
    context: SourceRequestContext,
  ): Promise<ResolvedSourcePlayback[]>;
  healthCheck(context: SourceRequestContext): Promise<SourceHealthResult>;
}

export class SourceError extends Error {
  constructor(
    public readonly kind:
      'timeout' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'invalid_url',
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const privateV4 = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
};
const privateV6 = (ip: string): boolean =>
  ip === '::1' ||
  ip === '::' ||
  ip.toLowerCase().startsWith('fc') ||
  ip.toLowerCase().startsWith('fd') ||
  ip.toLowerCase().startsWith('fe8') ||
  ip.toLowerCase().startsWith('fe9') ||
  ip.toLowerCase().startsWith('fea') ||
  ip.toLowerCase().startsWith('feb');

export async function assertSafeUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError('invalid_url', 'Invalid URL', false);
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new SourceError(
      'invalid_url',
      'Only credential-free HTTPS URLs on port 443 are allowed',
      false,
    );
  if (allowPrivate) return url;
  let addresses: { address: string }[];
  try {
    addresses = isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new SourceError('invalid_url', 'Unresolvable destination blocked', false);
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => (isIP(address) === 4 ? privateV4(address) : privateV6(address)))
  )
    throw new SourceError('invalid_url', 'Private or unresolvable destination blocked', false);
  return url;
}

export class SafeSourceClient {
  private readonly dispatcher: Agent;
  constructor(
    private readonly baseUrl: string,
    private readonly options: {
      allowPrivate: boolean;
      connectTimeoutMs: number;
      headersTimeoutMs: number;
    },
  ) {
    this.dispatcher = new Agent({
      connect: { timeout: options.connectTimeoutMs },
      headersTimeout: options.headersTimeoutMs,
      bodyTimeout: options.headersTimeoutMs,
    });
  }
  async getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    let target = await assertSafeUrl(
      new URL(path, this.baseUrl).toString(),
      this.options.allowPrivate,
    );
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await request(target, {
          method: 'GET',
          dispatcher: this.dispatcher,
          signal,
          headersTimeout: this.options.headersTimeoutMs,
        });
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers.location;
          await response.body.dump();
          if (!location || redirects === 3)
            throw new SourceError('invalid_url', 'Source redirect limit exceeded', false);
          target = await assertSafeUrl(
            new URL(location, target).toString(),
            this.options.allowPrivate,
          );
          continue;
        }
        if (response.statusCode === 429) {
          const seconds = Number(response.headers['retry-after']);
          throw new SourceError(
            'rate_limited',
            'Source rate limited request',
            true,
            Number.isFinite(seconds) ? seconds * 1000 : undefined,
          );
        }
        if (response.statusCode >= 500)
          throw new SourceError('unavailable', `Source returned ${response.statusCode}`, true);
        if (response.statusCode >= 400)
          throw new SourceError(
            'invalid_response',
            `Source returned ${response.statusCode}`,
            false,
          );
        return schema.parse(await response.body.json());
      }
      throw new SourceError('invalid_url', 'Source redirect limit exceeded', false);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (error instanceof z.ZodError)
        throw new SourceError(
          'invalid_response',
          `Source schema mismatch: ${error.issues.map((i) => i.path.join('.')).join(', ')}`,
          false,
        );
      const message = error instanceof Error ? error.message : 'Source request failed';
      throw new SourceError(
        message.toLowerCase().includes('timeout') ? 'timeout' : 'unavailable',
        message,
        true,
      );
    }
  }
}

export class SourceRegistry {
  private readonly adapters = new Map<string, VodSourceAdapter>();
  register(adapterName: string, adapter: VodSourceAdapter): void {
    if (this.adapters.has(adapterName)) throw new Error(`Duplicate adapter: ${adapterName}`);
    this.adapters.set(adapterName, adapter);
  }
  get(adapterName: string): VodSourceAdapter {
    const adapter = this.adapters.get(adapterName);
    if (!adapter)
      throw new SourceError('unavailable', `Adapter not registered: ${adapterName}`, false);
    return adapter;
  }
  entries(): VodSourceAdapter[] {
    return [...this.adapters.values()];
  }
}
