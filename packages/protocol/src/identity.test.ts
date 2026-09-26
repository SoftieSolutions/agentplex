import { describe, expect, it } from 'vitest';
import { sessionIdSchema, sessionRefKey, storeIdSchema } from './identity.js';
import type { SessionRef } from './identity.js';

function ref(storeId: string, sessionId: string): SessionRef {
  return { storeId: storeIdSchema.parse(storeId), sessionId: sessionIdSchema.parse(sessionId) };
}

describe('sessionRefKey', () => {
  it('gives equal refs equal keys, however the ref was built', () => {
    expect(sessionRefKey(ref('store-a', 'session-a'))).toBe(
      sessionRefKey({
        sessionId: ref('x', 'session-a').sessionId,
        storeId: ref('store-a', 'y').storeId,
      }),
    );
  });

  it('gives refs that differ in either id distinct keys', () => {
    const base = sessionRefKey(ref('store-a', 'session-a'));
    expect(sessionRefKey(ref('store-b', 'session-a'))).not.toBe(base);
    expect(sessionRefKey(ref('store-a', 'session-b'))).not.toBe(base);
    expect(sessionRefKey(ref('session-a', 'store-a'))).not.toBe(base);
  });

  it.each<[label: string, left: SessionRef, right: SessionRef]>([
    ['/', ref('a/b', 'c'), ref('a', 'b/c')],
    ['a space', ref('a b', 'c'), ref('a', 'b c')],
    ['NUL', ref('a\u0000b', 'c'), ref('a', 'b\u0000c')],
    ['a colon', ref('a:b', 'c'), ref('a', 'b:c')],
    ['a quote and comma', ref('a","b', 'c'), ref('a', 'b","c')],
  ])('keeps ids apart when they contain %s', (_label, left, right) => {
    expect(sessionRefKey(left)).not.toBe(sessionRefKey(right));
  });

  it('is a string that carries both ids', () => {
    const key = sessionRefKey(ref('store-a', 'session-a'));
    expect(typeof key).toBe('string');
    expect(key).toContain('store-a');
    expect(key).toContain('session-a');
  });
});
