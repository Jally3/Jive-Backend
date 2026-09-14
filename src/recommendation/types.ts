export type RecommendationMediaType = 'movie' | 'tv';
export type RecommendationCategory = 'movie' | 'tv' | 'animation' | 'variety';

export interface RecommendationHistoryInput {
  title: string;
  year: string;
  category: string;
  episodeName: string;
  progress: number;
  completed: boolean;
  watchedAt: string;
}

export interface RecommendationLibraryInput {
  title: string;
  year: string;
  category: string;
  favorite: boolean;
  following: boolean;
  updatedAt: string;
}

export interface RecommendationPreferenceInput {
  history: RecommendationHistoryInput[];
  library: RecommendationLibraryInput[];
}

export interface RecommendationCandidate {
  title: string;
  originalTitle: string;
  aliases: string[];
  year: string;
  mediaType: RecommendationMediaType;
  category: RecommendationCategory;
  latestSeasonNumber: number | null;
  modelConfidence: number;
  reason: string;
}

export interface RecommendationPage {
  index: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RecommendationMeta {
  requested: number;
  llmReturned: number;
  validAfterSchema: number;
  duplicatesRemovedInPage: number;
  duplicatesRemovedInSession: number;
  returned: number;
  cache: 'miss' | 'fresh' | 'stale' | 'cursor_replay';
}

export interface RecommendationResponse {
  requestId: string;
  clientRequestId: string;
  generatedAt: string;
  servedAt: string;
  expiresAt: string;
  sessionId: string;
  source: 'llm';
  mode: 'personalized';
  items: RecommendationCandidate[];
  page: RecommendationPage;
  meta: RecommendationMeta;
}

export interface RecommendationSession {
  id: string;
  subjectHash: string;
  preference: RecommendationPreferenceInput;
  preferenceFingerprint: string;
  locale: string;
  pageSize: number;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  identities: Set<string>;
  pages: RecommendationCandidate[][];
  responsesByCursor: Map<string, RecommendationResponse>;
  inFlightByCursor: Map<string, Promise<RecommendationResponse>>;
}

export class RecommendationError extends Error {
  clientRequestId?: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RecommendationError';
  }
}
