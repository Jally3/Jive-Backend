import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RecommendationError } from './types.js';

const VERSION = 'v1';

export class AnonymousSubjectIssuer {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('recommendation subject secret must contain at least 32 bytes');
    }
  }

  issue(): { anonymousSubjectId: string; issuedAt: string } {
    const issuedAt = new Date().toISOString();
    const payload = Buffer.from(
      JSON.stringify({ id: randomBytes(16).toString('base64url'), issuedAt }),
    ).toString('base64url');
    return { anonymousSubjectId: `${VERSION}.${payload}.${this.sign(payload)}`, issuedAt };
  }

  validate(value: string | undefined): string {
    if (!value || value.length > 512) throw invalidSubject();
    const [version, payload, signature, extra] = value.split('.');
    if (version !== VERSION || !payload || !signature || extra) throw invalidSubject();
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw invalidSubject();
    }
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        typeof (decoded as Record<string, unknown>).id !== 'string' ||
        typeof (decoded as Record<string, unknown>).issuedAt !== 'string'
      ) {
        throw invalidSubject();
      }
    } catch {
      throw invalidSubject();
    }
    return value;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(`${VERSION}.${payload}`).digest('base64url');
  }
}

const invalidSubject = (): RecommendationError =>
  new RecommendationError(401, 'INVALID_ANONYMOUS_SUBJECT', '匿名主体标识无效');
