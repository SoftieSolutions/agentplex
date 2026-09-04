import { describe, expect, it } from 'vitest';
import { sessionRefSchema } from '@agentplex/protocol';
import { parseSessionHash, sessionHash } from './session-route.js';

const ref = sessionRefSchema.parse({ storeId: 'store-observatory', sessionId: 'sess-1234' });

describe('sessionHash and parseSessionHash', () => {
  it('round-trips a ref', () => {
    expect(parseSessionHash(sessionHash(ref))).toEqual(ref);
  });

  it('round-trips ids that contain the separator, because ids are opaque', () => {
    const awkward = sessionRefSchema.parse({ storeId: 'a/b', sessionId: 'c#d?e' });
    expect(parseSessionHash(sessionHash(awkward))).toEqual(awkward);
  });

  it('rejects every other address as the placeholder, not a broken pane', () => {
    expect(parseSessionHash('')).toBeNull();
    expect(parseSessionHash('#/')).toBeNull();
    expect(parseSessionHash('#/session/')).toBeNull();
    expect(parseSessionHash('#/session/only-a-store')).toBeNull();
    expect(parseSessionHash('#/session/a/b/c')).toBeNull();
    expect(parseSessionHash('#/settings')).toBeNull();
  });

  it('rejects segments the schema refuses, empty ones included', () => {
    expect(parseSessionHash('#/session//sess-1')).toBeNull();
    expect(parseSessionHash(`#/session/${'x'.repeat(201)}/sess-1`)).toBeNull();
  });

  it('treats a malformed percent-escape as a bad address, not an exception', () => {
    expect(parseSessionHash('#/session/%E0%A4%A/sess-1')).toBeNull();
  });
});
