import { describe, expect, it } from 'vitest';
import { randomTokenMinter, tokenMatches } from './tokens.js';

describe('randomTokenMinter', () => {
  it('does not mint the same token twice', () => {
    const minted = new Set(Array.from({ length: 100 }, () => randomTokenMinter.newToken()));
    expect(minted.size).toBe(100);
  });

  it('mints something that survives a query string and a YAML file unescaped', () => {
    const token = randomTokenMinter.newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
    // 32 bytes, base64url, unpadded.
    expect(token).toHaveLength(43);
  });
});

describe('tokenMatches', () => {
  it('accepts the same secret', () => {
    expect(tokenMatches('a-secret', 'a-secret')).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(tokenMatches('a-secret', 'b-secret')).toBe(false);
  });

  /**
   * The reason the comparison hashes first. `timingSafeEqual` throws on inputs
   * of different lengths, and a throw here would be the credential's length
   * arriving at the caller as an exception rather than as a `false`.
   */
  it('rejects rather than throwing when the lengths differ', () => {
    expect(tokenMatches('short', 'a-much-longer-secret')).toBe(false);
    expect(tokenMatches('a-much-longer-secret', 'short')).toBe(false);
    expect(tokenMatches('', 'a-secret')).toBe(false);
  });

  it('rejects a secret that only shares a prefix', () => {
    expect(tokenMatches('secret-aaaa', 'secret-aaab')).toBe(false);
  });
});
