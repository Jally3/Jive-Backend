import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { RecommendationError } from './types.js';

export interface CursorPayload {
  sessionId: string;
  subjectHash: string;
  pageIndex: number;
  expiresAt: number;
}

export class RecommendationCursorCodec {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('recommendation cursor secret must contain at least 32 bytes');
    }
  }

  issue(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `v1.${encoded}.${this.sign(encoded)}`;
  }

  validate(value: string, subjectHash: string, now = Date.now()): CursorPayload {
    if (!value || value.length > 1_024) throw invalidCursor();
    const [version, encoded, signature, extra] = value.split('.');
    if (version !== 'v1' || !encoded || !signature || extra) throw invalidCursor();
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw invalidCursor();
    }
    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CursorPayload;
    } catch {
      throw invalidCursor();
    }
    if (
      !payload ||
      typeof payload.sessionId !== 'string' ||
      payload.subjectHash !== subjectHash ||
      !Number.isInteger(payload.pageIndex) ||
      payload.pageIndex < 2 ||
      !Number.isFinite(payload.expiresAt)
    ) {
      throw invalidCursor();
    }
    if (payload.expiresAt <= now) {
      throw new RecommendationError(
        410,
        'RECOMMENDATION_CURSOR_EXPIRED',
        '推荐会话已过期，请刷新后重试',
      );
    }
    return payload;
  }

  hash(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret).update(`v1.${encoded}`).digest('base64url');
  }
}

export const hashAnonymousSubject = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

const invalidCursor = (): RecommendationError =>
  new RecommendationError(400, 'INVALID_RECOMMENDATION_CURSOR', '推荐游标无效');
