import { createHmac } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { ArkRecommendationClient } from './ark-client.js';
import type { RecommendationBudgetStore } from './budget-store.js';
import { RecommendationControls } from './controls.js';
import { AnonymousSubjectIssuer } from './subject.js';
import { RecommendationCursorCodec } from './cursor.js';
import { buildRecommendationPrompt } from './prompt.js';
import { RecommendationMemoryStore } from './store.js';
import {
  RecommendationError,
  type RecommendationCandidate,
  type RecommendationResponse,
  type RecommendationSession,
} from './types.js';
import {
  preferenceFingerprint,
  stableDeduplicate,
  validateModelOutput,
  validateRecommendationRequest,
  type InitialRecommendationRequest,
} from './validator.js';

export interface ColdStartResponse {
  requestId: string;
  clientRequestId: string;
  servedAt: string;
  source: 'none';
  mode: 'cold_start';
  items: [];
  page: { index: 1; pageSize: number; hasMore: false; nextCursor: null };
  meta: { reason: 'insufficient_preference_signals'; llmCalled: false; cache: 'miss' };
}

export class RecommendationService {
  constructor(
    private readonly options: {
      enabled: boolean;
      promptVersion: string;
      modelVersion: string;
      parameterVersion: string;
      maxOutputTokens: number;
      minItemsForNextPage: number;
      fingerprintSecret: string;
      subjectIssuer: AnonymousSubjectIssuer;
      cursorCodec: RecommendationCursorCodec;
      store: RecommendationMemoryStore;
      controls: RecommendationControls;
      budget: Pick<RecommendationBudgetStore, 'reserve' | 'settle' | 'diagnostics'>;
      ark: Pick<ArkRecommendationClient, 'complete'>;
      logger: Logger;
    },
  ) {}

  issueAnonymousSubject(): { anonymousSubjectId: string; issuedAt: string } {
    return this.options.subjectIssuer.issue();
  }

  async recommend(
    raw: unknown,
    anonymousSubject: string | undefined,
    requestId: string,
    source: string,
  ): Promise<RecommendationResponse | ColdStartResponse> {
    const subject = this.options.subjectIssuer.validate(anonymousSubject);
    const subjectHash = this.subjectHash(subject);
    this.options.controls.checkRateLimit(subjectHash, source);
    const request = validateRecommendationRequest(raw);
    if (request.kind === 'next') {
      if (!this.options.enabled) throw disabled();
      return this.next(request.value.clientRequestId, request.value.cursor, subjectHash, requestId);
    }
    if (!this.options.enabled) throw disabled();
    if (
      request.value.preference.history.length === 0 &&
      request.value.preference.library.length === 0
    ) {
      return coldStart(request.value, requestId);
    }
    return this.initial(request.value, subjectHash, requestId);
  }

  validateEventSession(
    anonymousSubject: string | undefined,
    sessionId: string,
  ): RecommendationSession {
    const subjectHash = this.subjectHash(this.options.subjectIssuer.validate(anonymousSubject));
    const session = this.options.store.getSession(sessionId);
    if (session.subjectHash !== subjectHash) {
      throw new RecommendationError(400, 'INVALID_RECOMMENDATION_INPUT', 'sessionId 无效');
    }
    return session;
  }

  diagnostics(): object {
    return {
      enabled: this.options.enabled,
      memory: this.options.store.diagnostics(),
      controls: this.options.controls.diagnostics(),
      budget: this.options.budget.diagnostics(),
    };
  }

  recordEvent(event: {
    sessionId: string;
    pageIndex: number;
    candidatePosition: number;
    event: string;
  }): void {
    this.options.logger.info('recommendation event accepted', {
      sessionHash: createHmac('sha256', this.options.fingerprintSecret)
        .update(event.sessionId)
        .digest('base64url'),
      pageIndex: event.pageIndex,
      candidatePosition: event.candidatePosition,
      event: event.event,
    });
  }

  private async initial(
    input: InitialRecommendationRequest,
    subjectHash: string,
    requestId: string,
  ): Promise<RecommendationResponse> {
    const fingerprint = preferenceFingerprint(this.options.fingerprintSecret, input.preference, {
      locale: input.locale,
      promptVersion: this.options.promptVersion,
      modelVersion: this.options.modelVersion,
      parameterVersion: this.options.parameterVersion,
      schemaVersion: 1,
    });
    const fresh = this.options.store.getCache(fingerprint, false);
    if (fresh)
      return this.createFirstPage(
        input,
        subjectHash,
        fingerprint,
        fresh.candidates,
        fresh.generatedAt,
        'fresh',
        requestId,
      );
    const session = this.options.store.createSession({
      subjectHash,
      preference: input.preference,
      preferenceFingerprint: fingerprint,
      locale: input.locale,
      pageSize: input.pageSize,
    });
    try {
      const generated = await this.generate(session, []);
      this.options.store.setCache(fingerprint, generated.candidates, generated.generatedAt);
      return this.finishPage(session, input.clientRequestId, requestId, generated, 'miss');
    } catch (error) {
      this.options.store.deleteSession(session.id);
      const stale = this.options.store.getCache(fingerprint, true);
      if (stale && canUseStale(error)) {
        return this.createFirstPage(
          input,
          subjectHash,
          fingerprint,
          stale.candidates,
          stale.generatedAt,
          'stale',
          requestId,
        );
      }
      throw error;
    }
  }

  private subjectHash(subject: string): string {
    return createHmac('sha256', this.options.fingerprintSecret).update(subject).digest('base64url');
  }

  private async next(
    clientRequestId: string,
    cursor: string,
    subjectHash: string,
    requestId: string,
  ): Promise<RecommendationResponse> {
    const payload = this.options.cursorCodec.validate(cursor, subjectHash);
    const session = this.options.store.getSession(payload.sessionId);
    const cursorHash = this.options.cursorCodec.hash(cursor);
    const replay = session.responsesByCursor.get(cursorHash);
    if (replay) return structuredClone(replay);
    const inFlight = session.inFlightByCursor.get(cursorHash);
    if (inFlight) return inFlight;
    if (session.subjectHash !== subjectHash || payload.pageIndex !== session.pages.length + 1) {
      throw new RecommendationError(400, 'INVALID_RECOMMENDATION_CURSOR', '推荐游标无效');
    }
    const promise = this.generate(session, [...session.identities])
      .then((generated) => this.finishPage(session, clientRequestId, requestId, generated, 'miss'))
      .then((response) => {
        session.responsesByCursor.set(cursorHash, structuredClone(response));
        return response;
      })
      .finally(() => session.inFlightByCursor.delete(cursorHash));
    session.inFlightByCursor.set(cursorHash, promise);
    return promise;
  }

  private createFirstPage(
    input: InitialRecommendationRequest,
    subjectHash: string,
    fingerprint: string,
    candidates: RecommendationCandidate[],
    generatedAt: string,
    cache: 'fresh' | 'stale',
    requestId: string,
  ): RecommendationResponse {
    const session = this.options.store.createSession({
      subjectHash,
      preference: input.preference,
      preferenceFingerprint: fingerprint,
      locale: input.locale,
      pageSize: input.pageSize,
    });
    return this.finishPage(
      session,
      input.clientRequestId,
      requestId,
      {
        candidates,
        generatedAt,
        rawCount: candidates.length,
        validCount: candidates.length,
        duplicatesInPage: 0,
      },
      cache,
    );
  }

  private async generate(session: RecommendationSession, exclusions: string[]): Promise<Generated> {
    const started = performance.now();
    this.options.controls.assertNotCoolingDown();
    const release = await this.options.controls.acquire();
    const prompt = buildRecommendationPrompt({
      preference: session.preference,
      locale: session.locale,
      pageSize: 24,
      excludedIdentities: exclusions,
    });
    const reservation = await this.options.budget
      .reserve(session.subjectHash, prompt.estimatedInputTokens, this.options.maxOutputTokens)
      .catch((error) => {
        release();
        throw error;
      });
    try {
      const completion = await this.options.ark.complete(prompt.system, prompt.user);
      this.options.controls.recordUpstreamSuccess();
      if (completion.usage) {
        await this.options.budget.settle(
          reservation,
          completion.usage.promptTokens,
          completion.usage.completionTokens,
        );
      }
      const validation = validateModelOutput(parseModelContent(completion.content));
      const pageDeduplication = stableDeduplicate(validation.candidates);
      this.options.logger.info('recommendation generation completed', {
        subjectHash: session.subjectHash,
        sessionHash: createHmac('sha256', this.options.fingerprintSecret)
          .update(session.id)
          .digest('base64url'),
        arkRequestId: completion.requestId,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        llmReturned: validation.rawCount,
        validAfterSchema: validation.candidates.length,
        invalid: validation.invalidCount,
        duplicatesInPage: pageDeduplication.duplicates,
        promptTokens: completion.usage?.promptTokens,
        completionTokens: completion.usage?.completionTokens,
      });
      return {
        candidates: pageDeduplication.candidates,
        generatedAt: new Date().toISOString(),
        rawCount: validation.rawCount,
        validCount: validation.candidates.length,
        duplicatesInPage: pageDeduplication.duplicates,
      };
    } catch (error) {
      if (
        error instanceof RecommendationError &&
        error.code === 'RECOMMENDATION_UPSTREAM_RATE_LIMITED'
      ) {
        const delay = this.options.controls.recordUpstream429(error.retryAfterSeconds);
        throw new RecommendationError(503, error.code, error.message, true, delay);
      }
      this.options.logger.warn('recommendation generation failed', {
        subjectHash: session.subjectHash,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        code: error instanceof RecommendationError ? error.code : 'INTERNAL_ERROR',
      });
      throw error;
    } finally {
      release();
    }
  }

  private finishPage(
    session: RecommendationSession,
    clientRequestId: string,
    requestId: string,
    generated: Generated,
    cache: RecommendationResponse['meta']['cache'],
  ): RecommendationResponse {
    const deduplicated = stableDeduplicate(generated.candidates, session.identities);
    const items = deduplicated.candidates.slice(0, session.pageSize);
    for (const identity of deduplicated.identities.slice(0, session.pageSize))
      session.identities.add(identity);
    const index = session.pages.length + 1;
    session.pages.push(structuredClone(items));
    const hasMore = index < 3 && items.length >= this.options.minItemsForNextPage;
    const nextCursor = hasMore
      ? this.options.cursorCodec.issue({
          sessionId: session.id,
          subjectHash: session.subjectHash,
          pageIndex: index + 1,
          expiresAt: session.expiresAt,
        })
      : null;
    const servedAt = new Date().toISOString();
    return {
      requestId,
      clientRequestId,
      generatedAt: generated.generatedAt,
      servedAt,
      expiresAt: new Date(session.expiresAt).toISOString(),
      sessionId: session.id,
      source: 'llm',
      mode: 'personalized',
      items,
      page: { index, pageSize: session.pageSize, hasMore, nextCursor },
      meta: {
        requested: session.pageSize,
        llmReturned: generated.rawCount,
        validAfterSchema: generated.validCount,
        duplicatesRemovedInPage: generated.duplicatesInPage,
        duplicatesRemovedInSession: deduplicated.duplicates,
        returned: items.length,
        cache,
      },
    };
  }
}

interface Generated {
  candidates: RecommendationCandidate[];
  generatedAt: string;
  rawCount: number;
  validCount: number;
  duplicatesInPage: number;
}

function parseModelContent(content: string): unknown {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(match?.[1] ?? trimmed);
  } catch {
    throw new RecommendationError(502, 'RECOMMENDATION_INVALID_RESPONSE', '模型未返回有效推荐');
  }
}

function coldStart(input: InitialRecommendationRequest, requestId: string): ColdStartResponse {
  return {
    requestId,
    clientRequestId: input.clientRequestId,
    servedAt: new Date().toISOString(),
    source: 'none',
    mode: 'cold_start',
    items: [],
    page: { index: 1, pageSize: input.pageSize, hasMore: false, nextCursor: null },
    meta: { reason: 'insufficient_preference_signals', llmCalled: false, cache: 'miss' },
  };
}

function canUseStale(error: unknown): boolean {
  return error instanceof RecommendationError && error.status >= 429;
}

const disabled = (): RecommendationError =>
  new RecommendationError(503, 'RECOMMENDATION_DISABLED', '推荐功能当前已关闭');
