import { createHmac } from 'node:crypto';
import {
  RecommendationError,
  type RecommendationCandidate,
  type RecommendationCategory,
  type RecommendationHistoryInput,
  type RecommendationLibraryInput,
  type RecommendationMediaType,
  type RecommendationPreferenceInput,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set<RecommendationCategory>(['movie', 'tv', 'animation', 'variety']);

export interface InitialRecommendationRequest {
  clientRequestId: string;
  locale: string;
  pageSize: number;
  preference: RecommendationPreferenceInput;
}

export interface NextRecommendationRequest {
  clientRequestId: string;
  cursor: string;
}

export interface CandidateValidationResult {
  candidates: RecommendationCandidate[];
  rawCount: number;
  invalidCount: number;
}

export function validateRecommendationRequest(
  value: unknown,
):
  | { kind: 'initial'; value: InitialRecommendationRequest }
  | { kind: 'next'; value: NextRecommendationRequest } {
  const input = record(value);
  const clientRequestId = requiredClientRequestId(input.clientRequestId);
  if (input.cursor !== undefined) {
    rejectUnknownFields(input, new Set(['clientRequestId', 'cursor']));
    if (
      typeof input.cursor !== 'string' ||
      input.cursor.length === 0 ||
      input.cursor.length > 1_024
    ) {
      throw invalidInput('cursor 无效');
    }
    for (const forbidden of ['history', 'library', 'locale', 'pageSize']) {
      if (input[forbidden] !== undefined) throw invalidInput(`续页不得携带 ${forbidden}`);
    }
    return { kind: 'next', value: { clientRequestId, cursor: input.cursor } };
  }

  rejectUnknownFields(
    input,
    new Set(['clientRequestId', 'locale', 'pageSize', 'history', 'library']),
  );

  const locale = input.locale === undefined ? 'zh-CN' : boundedText(input.locale, 20, 'locale');
  const pageSize = input.pageSize === undefined ? 24 : input.pageSize;
  if (!Number.isInteger(pageSize) || (pageSize as number) < 12 || (pageSize as number) > 24) {
    throw invalidInput('pageSize 必须是 12 到 24 的整数');
  }
  const history = array(input.history, 'history', 20)
    .map(parseHistory)
    .sort((left, right) => Date.parse(right.watchedAt) - Date.parse(left.watchedAt));
  const library = array(input.library, 'library', 10)
    .map(parseLibrary)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return {
    kind: 'initial',
    value: {
      clientRequestId,
      locale,
      pageSize: pageSize as number,
      preference: {
        history: history.filter((item) => item.completed || item.progress >= 0.05),
        library: library.filter((item) => item.favorite || item.following),
      },
    },
  };
}

export function validateModelOutput(
  value: unknown,
  currentYear = new Date().getUTCFullYear(),
): CandidateValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.items)) throw invalidResponse();
  const candidates: RecommendationCandidate[] = [];
  let invalidCount = 0;
  for (const item of envelope.items) {
    const candidate = parseCandidate(item, currentYear);
    if (candidate) candidates.push(candidate);
    else invalidCount += 1;
  }
  if (candidates.length === 0) throw invalidResponse();
  return { candidates, rawCount: envelope.items.length, invalidCount };
}

export function stableDeduplicate(
  candidates: RecommendationCandidate[],
  existing: ReadonlySet<string> = new Set(),
): { candidates: RecommendationCandidate[]; identities: string[]; duplicates: number } {
  const seen = new Set(existing);
  const result: RecommendationCandidate[] = [];
  const identities: string[] = [];
  let duplicates = 0;
  for (const candidate of candidates) {
    const identity = candidateIdentity(candidate);
    if (!seen.add(identity)) {
      duplicates += 1;
      continue;
    }
    result.push(candidate);
    identities.push(identity);
  }
  return { candidates: result, identities, duplicates };
}

export function preferenceFingerprint(
  secret: string,
  preference: RecommendationPreferenceInput,
  context: object,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify({ preference, context }))
    .digest('base64url');
}

export function candidateIdentity(candidate: RecommendationCandidate): string {
  return `${candidate.mediaType}:${normalizeTitle(candidate.title)}:${candidate.year}`;
}

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function parseHistory(value: unknown): RecommendationHistoryInput {
  const input = record(value);
  const progress = input.progress;
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw invalidInput('history.progress 必须在 0 到 1 之间');
  }
  if (typeof input.completed !== 'boolean') throw invalidInput('history.completed 必须是布尔值');
  return {
    title: boundedText(input.title, 100, 'history.title'),
    year: optionalText(input.year, 4, 'history.year'),
    category: optionalText(input.category, 50, 'history.category'),
    episodeName: optionalText(input.episodeName, 50, 'history.episodeName'),
    progress,
    completed: input.completed,
    watchedAt: isoDate(input.watchedAt, 'history.watchedAt'),
  };
}

function parseLibrary(value: unknown): RecommendationLibraryInput {
  const input = record(value);
  if (typeof input.favorite !== 'boolean' || typeof input.following !== 'boolean') {
    throw invalidInput('library.favorite 和 following 必须是布尔值');
  }
  return {
    title: boundedText(input.title, 100, 'library.title'),
    year: optionalText(input.year, 4, 'library.year'),
    category: optionalText(input.category, 50, 'library.category'),
    favorite: input.favorite,
    following: input.following,
    updatedAt: isoDate(input.updatedAt, 'library.updatedAt'),
  };
}

function parseCandidate(value: unknown, currentYear: number): RecommendationCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.title !== 'string') return undefined;
  const title = clean(input.title);
  if (length(title) < 1 || length(title) > 100) return undefined;
  const mediaType = input.mediaType;
  if (mediaType !== 'movie' && mediaType !== 'tv') return undefined;
  const category = compatibleCategory(mediaType, input.category);
  const rawSeason = input.latestSeasonNumber;
  const latestSeasonNumber =
    mediaType === 'tv' &&
    Number.isInteger(rawSeason) &&
    (rawSeason as number) >= 1 &&
    (rawSeason as number) <= 100
      ? (rawSeason as number)
      : null;
  const rawConfidence = input.modelConfidence ?? input.confidence;
  const modelConfidence =
    typeof rawConfidence === 'number' &&
    Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.5;
  return {
    title,
    originalTitle: safeOptionalCandidateText(input.originalTitle, 100),
    aliases: aliases(input.aliases),
    year: validYear(input.year, currentYear),
    mediaType,
    category,
    latestSeasonNumber,
    modelConfidence,
    reason: sanitizeReason(input.reason),
  };
}

function compatibleCategory(
  mediaType: RecommendationMediaType,
  value: unknown,
): RecommendationCategory {
  const candidate =
    typeof value === 'string' && CATEGORIES.has(value as RecommendationCategory)
      ? (value as RecommendationCategory)
      : mediaType;
  if (mediaType === 'movie' && (candidate === 'movie' || candidate === 'animation'))
    return candidate;
  if (mediaType === 'tv' && candidate !== 'movie') return candidate;
  return mediaType;
}

function aliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const alias = clean(item);
    const normalized = normalizeTitle(alias);
    if (!alias || length(alias) > 100 || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(alias);
    if (result.length === 3) break;
  }
  return result;
}

function validYear(value: unknown, currentYear: number): string {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return '';
  const year = Number(value);
  return year >= 1900 && year <= currentYear + 2 ? value : '';
}

function sanitizeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withoutMarkup = clean(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#[\]()>]/g, '');
  if (
    /(性别|性取向|种族|民族|宗教|残疾|疾病|政治倾向|怀孕|gender|sexual orientation|race|religion|disability|disease|politic)/i.test(
      withoutMarkup,
    )
  ) {
    return '';
  }
  return truncate(withoutMarkup, 30);
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw invalidInput(`不支持字段 ${unknown}`);
}

function safeOptionalCandidateText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? truncate(clean(value), maximum) : '';
}

function requiredClientRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !UUID.test(value)) {
    throw invalidInput('clientRequestId 必须是 UUID');
  }
  return value;
}

function boundedText(value: unknown, maximum: number, name: string): string {
  if (typeof value !== 'string') throw invalidInput(`${name} 必须是字符串`);
  const result = clean(value);
  if (length(result) < 1 || length(result) > maximum) throw invalidInput(`${name} 长度无效`);
  return result;
}

function optionalText(value: unknown, maximum: number, name: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalidInput(`${name} 必须是字符串`);
  const result = clean(value);
  if (length(result) > maximum) throw invalidInput(`${name} 长度无效`);
  return result;
}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw invalidInput(`${name} 必须是 ISO 8601 时间`);
  }
  return new Date(value).toISOString();
}

function array(value: unknown, name: string, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw invalidInput(`${name} 数量无效`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidInput('请求必须是对象');
  return value as Record<string, unknown>;
}

function clean(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
}

function truncate(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function length(value: string): number {
  return Array.from(value).length;
}

const invalidInput = (message: string): RecommendationError =>
  new RecommendationError(400, 'INVALID_RECOMMENDATION_INPUT', message);

const invalidResponse = (): RecommendationError =>
  new RecommendationError(502, 'RECOMMENDATION_INVALID_RESPONSE', '模型未返回有效推荐');
