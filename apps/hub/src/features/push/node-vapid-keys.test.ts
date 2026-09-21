import { describe, expect, it } from 'vitest';
import { nodeVapidKeyGenerator } from './node-vapid-keys.js';
import { PUSH_KEY_MAX_CHARS } from './push.js';

/**
 * The one test that runs the real library.
 *
 * It exists because the wrapper is the seam every other test replaces, and a
 * seam nothing ever runs is a seam that is wrong on the first boot rather than
 * in CI. What it asserts is only what the feature above it relies on: that a
 * call produces two distinct base64url strings inside the bounds a stored key
 * is held to, and that two calls do not produce the same pair.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('the real VAPID key generator', () => {
  it('mints a pair of base64url keys inside the bounds this feature stores', () => {
    const { publicKey, privateKey } = nodeVapidKeyGenerator();

    expect(publicKey).toMatch(BASE64URL);
    expect(privateKey).toMatch(BASE64URL);
    expect(publicKey.length).toBeLessThanOrEqual(PUSH_KEY_MAX_CHARS);
    expect(privateKey.length).toBeLessThanOrEqual(PUSH_KEY_MAX_CHARS);
    expect(publicKey).not.toBe(privateKey);
  });

  it('mints a different pair every call, so nothing here is a fixed key', () => {
    expect(nodeVapidKeyGenerator().privateKey).not.toBe(nodeVapidKeyGenerator().privateKey);
  });
});
