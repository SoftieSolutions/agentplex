import { describe, expect, it } from 'vitest';
import { randomTokenMinter, tokenDigest, tokenMatches } from './tokens.js';

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

describe('tokenDigest', () => {
  it('is the same for the same secret and different for another', () => {
    expect(tokenDigest('a-secret')).toBe(tokenDigest('a-secret'));
    expect(tokenDigest('a-secret')).not.toBe(tokenDigest('b-secret'));
  });

  /**
   * The verifier is written into a file a person opens, so it has to survive
   * being read back out of JSON and pasted about, exactly as a minted token
   * does.
   */
  it('is fixed-width base64url whatever the secret was', () => {
    for (const secret of ['', 'short', randomTokenMinter.newToken()]) {
      const digest = tokenDigest(secret);
      expect(digest).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes of sha256, base64url, unpadded.
      expect(digest).toHaveLength(43);
    }
  });

  /**
   * The property the grants file rests on: what is stored is not what is
   * presented, so somebody who can read the file cannot present anything with
   * it.
   */
  it('does not contain the secret it was taken of', () => {
    expect(tokenDigest('a-secret')).not.toContain('a-secret');
  });

  it('is compared through tokenMatches like every other secret', () => {
    expect(tokenMatches(tokenDigest('a-secret'), tokenDigest('a-secret'))).toBe(true);
    expect(tokenMatches(tokenDigest('a-secret'), tokenDigest('b-secret'))).toBe(false);
  });
});
