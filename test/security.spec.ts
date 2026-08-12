import { describe, expect, it } from 'vitest';
import { assertSafeUrl } from '../packages/source-sdk/src/index.js';
import { redactObject } from '../packages/observability/src/index.js';
import { issueInstallationToken, parseInstallationToken } from '../packages/contracts/src/index.js';

describe('security boundaries', () => {
  it('blocks credentials, insecure protocol and private literals', async () => {
    await expect(assertSafeUrl('http://example.com/a.m3u8')).rejects.toThrow();
    await expect(assertSafeUrl('https://user:pass@example.com/a.m3u8')).rejects.toThrow();
    await expect(assertSafeUrl('https://127.0.0.1/a.m3u8')).rejects.toThrow();
  });
  it('redacts credentials and URL queries', () => {
    expect(
      redactObject({
        authorization: 'Bearer secret',
        nested: { url: 'https://a.example/path?token=bad' },
      }),
    ).toEqual({ authorization: '[REDACTED]', nested: { url: 'https://a.example/path' } });
  });
  it('detects a tampered installation token', () => {
    const secret = 'a'.repeat(32);
    const token = issueInstallationToken('ins_ABC', secret);
    expect(parseInstallationToken(token, secret)).toBe('ins_ABC');
    expect(parseInstallationToken(`${token}x`, secret)).toBeNull();
  });
});
