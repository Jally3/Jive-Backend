import { RecommendationError } from './types.js';

export interface ArkCompletion {
  content: string;
  requestId?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ArkStreamEvent {
  content?: string;
  usage?: ArkCompletion['usage'];
}

export interface ArkCompletionStream {
  events: AsyncIterable<ArkStreamEvent>;
  requestId?: string;
}

export class ArkRecommendationClient {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
      maxOutputTokens: number;
      maxResponseBytes: number;
      temperature: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async complete(system: string, user: string): Promise<ArkCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: this.options.temperature,
            max_tokens: this.options.maxOutputTokens,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        },
      );
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (response.status === 429) {
        await drainLimited(response, this.options.maxResponseBytes).catch(() => undefined);
        throw new RecommendationError(
          503,
          'RECOMMENDATION_UPSTREAM_RATE_LIMITED',
          '推荐上游请求过于频繁',
          true,
          retryAfter(response.headers.get('retry-after')),
        );
      }
      if (!response.ok) {
        await drainLimited(response, this.options.maxResponseBytes).catch(() => undefined);
        throw new RecommendationError(
          503,
          'RECOMMENDATION_UPSTREAM_UNAVAILABLE',
          '推荐服务暂时不可用',
          true,
          10,
        );
      }
      const raw = await drainLimited(response, this.options.maxResponseBytes);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw invalidResponse();
      }
      if (!body || typeof body !== 'object') throw invalidResponse();
      const envelope = body as Record<string, unknown>;
      const choices = envelope.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message =
        first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
      const content =
        message && typeof message === 'object'
          ? (message as Record<string, unknown>).content
          : undefined;
      if (typeof content !== 'string') throw invalidResponse();
      const usageValue = envelope.usage;
      const usage = parseUsage(usageValue);
      return {
        content,
        ...(requestId ? { requestId } : {}),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof RecommendationError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RecommendationError(
          504,
          'RECOMMENDATION_UPSTREAM_TIMEOUT',
          '推荐服务响应超时',
          true,
          10,
        );
      }
      throw new RecommendationError(
        503,
        'RECOMMENDATION_UPSTREAM_UNAVAILABLE',
        '推荐服务暂时不可用',
        true,
        10,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async stream(
    system: string,
    user: string,
    externalSignal?: AbortSignal,
  ): Promise<ArkCompletionStream> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    timer.unref();
    const abortFromCaller = (): void => controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: this.options.temperature,
            max_tokens: this.options.maxOutputTokens,
            response_format: { type: 'json_object' },
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        },
      );
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (response.status === 429) {
        await drainLimited(response, this.options.maxResponseBytes).catch(() => undefined);
        throw new RecommendationError(
          503,
          'RECOMMENDATION_UPSTREAM_RATE_LIMITED',
          '推荐上游请求过于频繁',
          true,
          retryAfter(response.headers.get('retry-after')),
        );
      }
      if (!response.ok || !response.body) {
        await drainLimited(response, this.options.maxResponseBytes).catch(() => undefined);
        throw new RecommendationError(
          503,
          'RECOMMENDATION_UPSTREAM_UNAVAILABLE',
          '推荐服务暂时不可用',
          true,
          10,
        );
      }
      const events = readCompletionEvents(
        response.body,
        this.options.maxResponseBytes,
        () => {
          clearTimeout(timer);
          externalSignal?.removeEventListener('abort', abortFromCaller);
        },
        () => timedOut,
        () => externalSignal?.aborted === true,
      );
      return {
        events,
        ...(requestId ? { requestId } : {}),
      };
    } catch (error) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
      if (error instanceof RecommendationError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        if (!timedOut && externalSignal?.aborted) {
          throw new RecommendationError(499, 'RECOMMENDATION_CLIENT_ABORTED', '客户端已断开');
        }
        throw new RecommendationError(
          504,
          'RECOMMENDATION_UPSTREAM_TIMEOUT',
          '推荐服务响应超时',
          true,
          10,
        );
      }
      throw new RecommendationError(
        503,
        'RECOMMENDATION_UPSTREAM_UNAVAILABLE',
        '推荐服务暂时不可用',
        true,
        10,
      );
    }
  }
}

async function* readCompletionEvents(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  cleanup: () => void,
  timedOut: () => boolean,
  callerAborted: () => boolean,
): AsyncGenerator<ArkStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw invalidResponse();
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          const parsed = parseStreamData(dataLines.join('\n'));
          dataLines = [];
          if (parsed === 'done') {
            finished = true;
            return;
          }
          if (parsed) yield parsed;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
    const parsed = parseStreamData(dataLines.join('\n'));
    if (parsed === 'done') finished = true;
    else if (parsed) yield parsed;
    if (!finished) throw invalidResponse();
  } catch (error) {
    if (error instanceof RecommendationError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      if (!timedOut() && callerAborted()) {
        throw new RecommendationError(499, 'RECOMMENDATION_CLIENT_ABORTED', '客户端已断开');
      }
      throw new RecommendationError(
        504,
        'RECOMMENDATION_UPSTREAM_TIMEOUT',
        '推荐服务响应超时',
        true,
        10,
      );
    }
    throw new RecommendationError(
      503,
      'RECOMMENDATION_UPSTREAM_UNAVAILABLE',
      '推荐服务暂时不可用',
      true,
      10,
    );
  } finally {
    cleanup();
    reader.releaseLock();
  }
}

function parseStreamData(value: string): ArkStreamEvent | 'done' | undefined {
  if (!value) return undefined;
  if (value.trim() === '[DONE]') return 'done';
  let body: unknown;
  try {
    body = JSON.parse(value);
  } catch {
    throw invalidResponse();
  }
  if (!body || typeof body !== 'object') throw invalidResponse();
  const envelope = body as Record<string, unknown>;
  const choices = envelope.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const delta =
    first && typeof first === 'object' ? (first as Record<string, unknown>).delta : undefined;
  const content =
    delta && typeof delta === 'object' ? (delta as Record<string, unknown>).content : undefined;
  const usage = parseUsage(envelope.usage);
  if (content !== undefined && typeof content !== 'string') throw invalidResponse();
  if (typeof content !== 'string' && !usage) return undefined;
  return {
    ...(typeof content === 'string' && content ? { content } : {}),
    ...(usage ? { usage } : {}),
  };
}

async function drainLimited(response: Response, maximum: number): Promise<string> {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maximum) throw invalidResponse();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw invalidResponse();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseUsage(value: unknown): ArkCompletion['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  return typeof promptTokens === 'number' && typeof completionTokens === 'number'
    ? { promptTokens, completionTokens }
    : undefined;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(60, Math.max(1, Math.ceil(seconds)));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(60, Math.max(1, Math.ceil((date - Date.now()) / 1_000)))
    : undefined;
}

const invalidResponse = (): RecommendationError =>
  new RecommendationError(502, 'RECOMMENDATION_INVALID_RESPONSE', '模型未返回有效推荐');
