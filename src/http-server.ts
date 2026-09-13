import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getHeapStatistics } from 'node:v8';
import { ADMIN_PAGE } from './admin-page.js';
import type { EncodedSnapshot } from './catalog-service.js';
import type { Logger } from './logger.js';
import type { MonitoringService } from './monitoring-service.js';
import { isFeedName, type FeedName } from './types.js';

interface Bucket {
  window: number;
  count: number;
}

export function createCatalogServer(options: {
  catalog: CatalogReader;
  logger: Logger;
  rateLimitPerMinute: number;
  trustProxy: boolean;
  monitoring?: MonitoringService;
  adminEnabled?: boolean;
  tmdbDiagnostics?: () => object;
}): Server {
  const buckets = new Map<string, Bucket>();
  let requestCount = 0;
  let errorCount = 0;
  const server = createServer((request, response) => {
    const started = performance.now();
    const requestId = `req_${randomUUID()}`;
    let metricRoute = 'unknown';
    response.setHeader('x-request-id', requestId);
    response.once('finish', () => {
      options.monitoring?.recordHttp({
        route: metricRoute,
        statusCode: response.statusCode,
        durationMs: performance.now() - started,
        responseBytes: Number(response.getHeader('content-length') ?? 0),
        contentEncoding: String(response.getHeader('content-encoding') ?? 'identity'),
      });
    });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      metricRoute = routeName(url);
      if (request.method !== 'GET')
        return failure(response, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求', requestId);
      if (url.pathname === '/health/live') return json(response, 200, { status: 'ok' });
      if (url.pathname === '/health/ready') {
        const readiness = options.catalog.readiness();
        return json(response, readiness.ready ? 200 : 503, readiness);
      }
      if (url.pathname === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        return response.end(
          `jive_catalog_http_requests_total ${requestCount}\n` +
            `jive_catalog_http_errors_total ${errorCount}\n`,
        );
      }

      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (!options.adminEnabled)
          return failure(response, 404, 'NOT_FOUND', '资源不存在', requestId);
        return html(response, ADMIN_PAGE);
      }
      if (url.pathname === '/admin/api/overview') {
        if (!options.adminEnabled || !options.monitoring)
          return failure(response, 404, 'NOT_FOUND', '资源不存在', requestId);
        const days = boundedInteger(url.searchParams.get('days'), 30, 1, 90);
        void options.monitoring.flush().catch((error) =>
          options.logger.error('manual monitoring flush failed', {
            error: error instanceof Error ? error.message : 'unknown error',
          }),
        );
        return json(
          response,
          200,
          {
            generatedAt: new Date().toISOString(),
            history: options.monitoring.overview(days),
            runtime: {
              uptimeSeconds: Math.round(process.uptime()),
              memory: process.memoryUsage(),
              heapLimit: getHeapStatistics().heap_size_limit,
              nodeVersion: process.version,
            },
            catalog: options.catalog.diagnostics?.() ?? options.catalog.readiness(),
            tmdb: options.tmdbDiagnostics?.() ?? {},
          },
          { 'cache-control': 'no-store' },
        );
      }
      if (url.pathname === '/admin/api/catalog/items') {
        if (!options.adminEnabled)
          return failure(response, 404, 'NOT_FOUND', '资源不存在', requestId);
        const feed = url.searchParams.get('feed');
        if (!isFeedName(feed))
          return failure(response, 400, 'INVALID_ARGUMENT', '无效的 feed', requestId);
        const group = url.searchParams.get('group') ?? 'all';
        if (!['all', 'movie', 'tv', 'animation', 'variety'].includes(group)) {
          return failure(response, 400, 'INVALID_ARGUMENT', '无效的 group', requestId);
        }
        const encoded = options.catalog.get(feed);
        if (!encoded)
          return failure(response, 503, 'CATALOG_UNAVAILABLE', '榜单暂时不可用', requestId);
        const page = boundedInteger(url.searchParams.get('page'), 1, 1, 10_000);
        const pageSize = boundedInteger(url.searchParams.get('pageSize'), 20, 1, 100);
        const ids = encoded.snapshot.groups[group as keyof typeof encoded.snapshot.groups];
        const offset = (page - 1) * pageSize;
        return json(
          response,
          200,
          {
            feed,
            group,
            page,
            pageSize,
            total: ids.length,
            items: ids.slice(offset, offset + pageSize).map((id) => encoded.snapshot.items[id]),
          },
          { 'cache-control': 'no-store' },
        );
      }

      requestCount += 1;
      if (!allow(clientIp(request, options.trustProxy), options.rateLimitPerMinute, buckets)) {
        errorCount += 1;
        response.setHeader('retry-after', '60');
        return failure(response, 429, 'RATE_LIMITED', '请求过于频繁', requestId);
      }

      if (
        url.pathname === '/api/tmdb/v1/manifest' ||
        url.pathname === '/data/tmdb/v1/manifest.json'
      ) {
        return json(response, 200, options.catalog.manifest(), {
          'cache-control': 'public, max-age=60',
        });
      }
      const feed = routeFeed(url);
      if (feed === 'invalid') {
        errorCount += 1;
        return failure(
          response,
          400,
          'INVALID_ARGUMENT',
          'feed 仅支持 latest、popular、top_rated',
          requestId,
        );
      }
      if (!feed) {
        errorCount += 1;
        return failure(response, 404, 'NOT_FOUND', '资源不存在', requestId);
      }
      const snapshot = options.catalog.get(feed);
      if (!snapshot) {
        errorCount += 1;
        return failure(
          response,
          503,
          'CATALOG_UNAVAILABLE',
          '榜单暂时不可用，请稍后重试',
          requestId,
        );
      }
      return sendSnapshot(request, response, snapshot);
    } catch (error) {
      errorCount += 1;
      options.logger.error('request failed', {
        requestId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return failure(response, 500, 'INTERNAL_ERROR', '服务暂时不可用', requestId);
    } finally {
      options.logger.info('request completed', {
        requestId,
        method: request.method,
        path: request.url,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  server.maxRequestsPerSocket = 1_000;
  setInterval(() => pruneBuckets(buckets), 60_000).unref();
  return server;
}

export interface CatalogReader {
  get(feed: FeedName, now?: number): EncodedSnapshot | undefined;
  manifest(now?: number): object;
  readiness(now?: number): {
    ready: boolean;
    status: 'ok' | 'degraded' | 'unavailable';
    feeds: Record<string, string>;
  };
  diagnostics?(now?: number): object;
}

function routeName(url: URL): string {
  if (url.pathname === '/api/tmdb/v1/catalog') {
    const feed = url.searchParams.get('feed');
    return isFeedName(feed) ? `catalog/${feed}` : 'catalog/invalid';
  }
  const names: Record<string, string> = {
    '/data/tmdb/v1/latest.json': 'catalog/latest',
    '/data/tmdb/v1/popular.json': 'catalog/popular',
    '/data/tmdb/v1/top-rated.json': 'catalog/top_rated',
    '/api/tmdb/v1/manifest': 'manifest',
    '/data/tmdb/v1/manifest.json': 'manifest',
    '/health/live': 'health/live',
    '/health/ready': 'health/ready',
    '/metrics': 'metrics',
    '/admin': 'admin/page',
    '/admin/': 'admin/page',
    '/admin/api/overview': 'admin/overview',
    '/admin/api/catalog/items': 'admin/catalog_items',
  };
  return names[url.pathname] ?? 'not_found';
}

function routeFeed(url: URL): FeedName | 'invalid' | undefined {
  if (url.pathname === '/api/tmdb/v1/catalog') {
    const feed = url.searchParams.get('feed');
    return isFeedName(feed) ? feed : 'invalid';
  }
  const routes: Record<string, FeedName> = {
    '/data/tmdb/v1/latest.json': 'latest',
    '/data/tmdb/v1/popular.json': 'popular',
    '/data/tmdb/v1/top-rated.json': 'top_rated',
  };
  return routes[url.pathname];
}

function sendSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
  encoded: EncodedSnapshot,
): void {
  response.setHeader('etag', encoded.etag);
  response.setHeader('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
  response.setHeader('x-catalog-revision', encoded.snapshot.revision);
  response.setHeader('x-catalog-stale', String(encoded.snapshot.stale));
  response.setHeader('vary', 'Accept-Encoding');
  if (
    request.headers['if-none-match']
      ?.split(',')
      .map((value) => value.trim())
      .includes(encoded.etag)
  ) {
    response.writeHead(304);
    response.end();
    return;
  }
  const accepted = request.headers['accept-encoding'] ?? '';
  const [body, encoding] = accepted.includes('br')
    ? [encoded.br, 'br']
    : accepted.includes('gzip')
      ? [encoded.gzip, 'gzip']
      : [encoded.json, undefined];
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  };
  if (encoding) headers['content-encoding'] = encoding;
  response.writeHead(200, headers);
  response.end(body);
}

function json(
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

function failure(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  json(response, status, { error: { code, message, requestId } });
}

function allow(key: string, maximum: number, buckets: Map<string, Bucket>): boolean {
  const window = Math.floor(Date.now() / 60_000);
  const bucket = buckets.get(key);
  if (!bucket || bucket.window !== window) {
    if (!bucket && buckets.size >= 20_000) return false;
    buckets.set(key, { window, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= maximum;
}

function pruneBuckets(buckets: Map<string, Bucket>): void {
  const current = Math.floor(Date.now() / 60_000);
  for (const [key, bucket] of buckets) if (bucket.window < current) buckets.delete(key);
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? 'unknown';
}
