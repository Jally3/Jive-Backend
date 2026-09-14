import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger.js';
import { ArkRecommendationClient, type ArkCompletion } from '../src/recommendation/ark-client.js';
import { RecommendationBudgetStore } from '../src/recommendation/budget-store.js';
import { RecommendationControls } from '../src/recommendation/controls.js';
import { RecommendationCursorCodec } from '../src/recommendation/cursor.js';
import { RecommendationService } from '../src/recommendation/service.js';
import { RecommendationMemoryStore } from '../src/recommendation/store.js';
import { AnonymousSubjectIssuer } from '../src/recommendation/subject.js';
import { JsonItemsStreamParser } from '../src/recommendation/json-items-stream.js';
import {
  validateModelOutput,
  validateRecommendationRequest,
} from '../src/recommendation/validator.js';

const secret = '0123456789abcdef0123456789abcdef';

describe('recommendation validation and identity', () => {
  it('issues signed anonymous subjects and rejects modified values', () => {
    const issuer = new AnonymousSubjectIssuer(secret);
    const issued = issuer.issue();
    expect(issuer.validate(issued.anonymousSubjectId)).toBe(issued.anonymousSubjectId);
    expect(() => issuer.validate(`${issued.anonymousSubjectId}x`)).toThrow('匿名主体');
  });

  it('sorts, filters and repairs model candidates', () => {
    const request = validateRecommendationRequest({
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      history: [
        { title: 'old', progress: 1, completed: true, watchedAt: '2025-01-01T00:00:00Z' },
        { title: 'ignored', progress: 0.01, completed: false, watchedAt: '2026-01-01T00:00:00Z' },
      ],
      library: [],
    });
    expect(request.kind).toBe('initial');
    if (request.kind === 'initial')
      expect(request.value.preference.history.map((item) => item.title)).toEqual(['old']);
    expect(
      validateModelOutput({
        items: [{ title: '示例', mediaType: 'movie', category: 'variety', latestSeasonNumber: 2 }],
      }).candidates[0],
    ).toMatchObject({ category: 'movie', latestSeasonNumber: null, modelConfidence: 0.5 });
  });
});

describe('recommendation streaming', () => {
  it('parses Ark SSE split at arbitrary byte boundaries', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      [
        'data: {"choices":[{"delta":{"content":"{\\"items\\":[{\\"title\\":\\"流"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"式\\",\\"mediaType\\":\\"movie\\",\\"category\\":\\"movie\\"}]}"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );
    const chunks = [bytes.slice(0, 73), bytes.slice(73, 79), bytes.slice(79)];
    let requestBody = '';
    const client = new ArkRecommendationClient({
      apiKey: 'test',
      baseUrl: 'https://example.invalid',
      model: 'test',
      timeoutMs: 1_000,
      maxOutputTokens: 1_000,
      maxResponseBytes: 10_000,
      temperature: 0.4,
      fetchImpl: async (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
        requestBody = init.body;
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200, headers: { 'x-request-id': 'ark_req' } },
        );
      },
    });
    const stream = await client.stream('system', 'user');
    let content = '';
    let usage;
    for await (const event of stream.events) {
      content += event.content ?? '';
      usage = event.usage ?? usage;
    }
    expect(JSON.parse(requestBody)).toMatchObject({ stream: true });
    expect(stream.requestId).toBe('ark_req');
    expect(JSON.parse(content)).toEqual({
      items: [{ title: '流式', mediaType: 'movie', category: 'movie' }],
    });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('extracts completed items without being confused by escaped braces', () => {
    const parser = new JsonItemsStreamParser();
    expect(parser.push('{"items":[{"title":"a } \\" b",')).toEqual([]);
    expect(parser.push('"mediaType":"movie"},{"title":"c","mediaType":"tv"}]}')).toHaveLength(2);
    expect(JSON.parse(parser.finish())).toHaveProperty('items');
  });

  it('streams validated items and commits the page only after completion', async () => {
    const issuer = new AnonymousSubjectIssuer(secret);
    const store = new RecommendationMemoryStore({
      maxSessions: 10,
      maxCacheEntries: 10,
      sessionTtlMs: 30 * 60_000,
      freshTtlMs: 30 * 60_000,
      staleTtlMs: 24 * 60 * 60_000,
      cleanupIntervalMs: 60_000,
    });
    const content = JSON.stringify({
      items: Array.from({ length: 4 }, (_, index) => ({
        title: `流式作品-${index}`,
        mediaType: 'movie',
        category: 'movie',
      })),
    });
    const service = new RecommendationService({
      enabled: true,
      promptVersion: 'v1',
      modelVersion: 'test',
      parameterVersion: 'test',
      maxOutputTokens: 1_000,
      minItemsForNextPage: 4,
      fingerprintSecret: secret,
      subjectIssuer: issuer,
      cursorCodec: new RecommendationCursorCodec(secret),
      store,
      controls: new RecommendationControls({
        subjectRateLimitPerMinute: 10,
        sourceRateLimitPerMinute: 10,
        maxRateLimitSubjects: 10,
        maxConcurrency: 1,
        maxQueue: 1,
      }),
      budget: {
        reserve: async () => ({ subjectHash: 'x', tokens: 1, costMicros: 1, date: 'x' }),
        settle: async () => undefined,
        diagnostics: () => ({ available: true }),
      },
      ark: {
        complete: async () => ({ content }),
        stream: async () => ({
          events: (async function* () {
            yield { content: content.slice(0, 45) };
            yield { content: content.slice(45), usage: { promptTokens: 10, completionTokens: 20 } };
          })(),
        }),
      },
      logger: new Logger('error'),
    });
    const events = [];
    for await (const event of service.streamRecommendations(
      {
        clientRequestId: '00000000-0000-4000-8000-000000000003',
        history: [
          { title: '偏好', progress: 1, completed: true, watchedAt: new Date().toISOString() },
        ],
      },
      issuer.issue().anonymousSubjectId,
      'req_stream',
      '127.0.0.1',
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'item',
      'item',
      'item',
      'item',
      'done',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { mode: 'personalized' } });
  });
});

describe('recommendation budgets', () => {
  it('persists a reservation before allowing the call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-budget-'));
    const stateFile = join(directory, 'budget.json');
    const budget = createBudget(stateFile);
    await budget.start();
    await budget.reserve('subject', 100, 200);
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as {
      global: { calls: number; tokens: number };
    };
    expect(saved.global).toMatchObject({ calls: 1, tokens: 300 });
  });

  it('fails closed when an existing budget ledger is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-budget-corrupt-'));
    const stateFile = join(directory, 'budget.json');
    await writeFile(stateFile, '{broken');
    const budget = createBudget(stateFile);
    await budget.start();
    await expect(budget.reserve('subject', 100, 200)).rejects.toMatchObject({
      code: 'RECOMMENDATION_BUDGET_STATE_UNAVAILABLE',
    });
  });
});

describe('recommendation concurrency and cooldown', () => {
  it('bounds the queue and blocks calls during an upstream 429 cooldown', async () => {
    let now = 1_000;
    const controls = new RecommendationControls({
      subjectRateLimitPerMinute: 10,
      sourceRateLimitPerMinute: 10,
      maxRateLimitSubjects: 10,
      maxConcurrency: 1,
      maxQueue: 1,
      now: () => now,
    });
    const release = await controls.acquire();
    const queued = controls.acquire();
    expect(() => controls.acquire()).toThrowError(/等待队列/);
    release();
    const releaseQueued = await queued;
    releaseQueued();
    expect(controls.recordUpstream429()).toBe(5);
    expect(() => controls.assertNotCoolingDown()).toThrowError(/冷却/);
    now += 5_000;
    expect(() => controls.assertNotCoolingDown()).not.toThrow();
  });
});

describe('recommendation cursor single-flight', () => {
  it('makes only one upstream call for 20 concurrent requests with one cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jive-recommendation-'));
    const store = new RecommendationMemoryStore({
      maxSessions: 10,
      maxCacheEntries: 10,
      sessionTtlMs: 30 * 60_000,
      freshTtlMs: 30 * 60_000,
      staleTtlMs: 24 * 60 * 60_000,
      cleanupIntervalMs: 60_000,
    });
    const issuer = new AnonymousSubjectIssuer(secret);
    const budget = createBudget(join(directory, 'budget.json'));
    await budget.start();
    let calls = 0;
    const service = new RecommendationService({
      enabled: true,
      promptVersion: 'v1',
      modelVersion: 'test-model',
      parameterVersion: 'test',
      maxOutputTokens: 1_000,
      minItemsForNextPage: 4,
      fingerprintSecret: secret,
      subjectIssuer: issuer,
      cursorCodec: new RecommendationCursorCodec(secret),
      store,
      controls: new RecommendationControls({
        subjectRateLimitPerMinute: 100,
        sourceRateLimitPerMinute: 100,
        maxRateLimitSubjects: 100,
        maxConcurrency: 4,
        maxQueue: 16,
      }),
      budget,
      ark: {
        complete: async (): Promise<ArkCompletion> => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            content: JSON.stringify({
              items: Array.from({ length: 12 }, (_, index) => ({
                title: `作品-${calls}-${index}`,
                mediaType: 'movie',
                category: 'movie',
              })),
            }),
            usage: { promptTokens: 100, completionTokens: 200 },
          };
        },
      },
      logger: new Logger('error'),
    });
    const subject = issuer.issue().anonymousSubjectId;
    const first = await service.recommend(
      {
        clientRequestId: '00000000-0000-4000-8000-000000000001',
        history: [
          { title: '偏好', progress: 1, completed: true, watchedAt: new Date().toISOString() },
        ],
      },
      subject,
      'req_first',
      '127.0.0.1',
    );
    expect(first.mode).toBe('personalized');
    if (first.mode !== 'personalized' || !first.page.nextCursor) throw new Error('missing cursor');
    const nextRequest = {
      clientRequestId: '00000000-0000-4000-8000-000000000002',
      cursor: first.page.nextCursor,
    };
    const pages = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.recommend(nextRequest, subject, 'req_next', '127.0.0.1'),
      ),
    );
    expect(calls).toBe(2);
    expect(pages.every((page) => JSON.stringify(page) === JSON.stringify(pages[0]))).toBe(true);
  });
});

function createBudget(stateFile: string): RecommendationBudgetStore {
  return new RecommendationBudgetStore({
    stateFile,
    timezone: 'UTC',
    maxSubjects: 100,
    subjectDailyCalls: 100,
    subjectDailyTokens: 1_000_000,
    globalDailyCalls: 100,
    globalDailyTokens: 1_000_000,
    globalDailyCostYuan: 100,
    inputYuanPerMillionTokens: 1,
    outputYuanPerMillionTokens: 2,
  });
}
