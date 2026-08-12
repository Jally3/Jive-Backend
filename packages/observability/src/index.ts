import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { trace } from '@opentelemetry/api';

export const metrics = new Registry();
collectDefaultMetrics({ register: metrics, prefix: 'jive_' });
export const httpRequests = new Counter({
  name: 'jive_http_requests_total',
  help: 'API requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metrics],
});
export const httpDuration = new Histogram({
  name: 'jive_http_request_duration_seconds',
  help: 'API request duration',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 3, 5],
  registers: [metrics],
});
export const sourceRequests = new Counter({
  name: 'jive_source_requests_total',
  help: 'Source adapter requests',
  labelNames: ['source', 'result'] as const,
  registers: [metrics],
});
export const playbackSwitches = new Counter({
  name: 'jive_playback_switches_total',
  help: 'Playback candidate switches',
  registers: [metrics],
});

const sensitive = /authorization|cookie|token|secret|signature|playback.*url|vod_play_url/i;
export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitive.test(key) ? '[REDACTED]' : redactObject(entry),
      ]),
    );
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      url.search = '';
      return `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  }
  return value;
}

export const currentTraceId = (): string | undefined =>
  trace.getActiveSpan()?.spanContext().traceId;

export async function startTelemetry(
  endpoint?: string,
): Promise<(() => Promise<void>) | undefined> {
  if (!endpoint) return undefined;
  const [{ NodeSDK }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
  ]);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return async () => sdk.shutdown();
}
