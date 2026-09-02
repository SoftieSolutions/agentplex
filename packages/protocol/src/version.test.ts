import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, checkProtocolVersion } from './version.js';

describe('checkProtocolVersion', () => {
  it('accepts only an exact match', () => {
    expect(checkProtocolVersion(PROTOCOL_VERSION)).toBeNull();
  });

  it('refuses a newer peer rather than guessing what it added', () => {
    expect(checkProtocolVersion(PROTOCOL_VERSION + 1)).toEqual({
      expected: PROTOCOL_VERSION,
      received: PROTOCOL_VERSION + 1,
    });
  });

  it('refuses an older peer rather than guessing what it lacks', () => {
    expect(checkProtocolVersion(PROTOCOL_VERSION - 1)).toEqual({
      expected: PROTOCOL_VERSION,
      received: PROTOCOL_VERSION - 1,
    });
  });
});
