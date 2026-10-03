import { describe, expect, it } from 'vitest';
import { frameIdSchema } from '@agentplex/protocol';
import { parseStartHash, startHash } from './start-route.js';

const SEVEN = frameIdSchema.parse(7);

describe('startHash and parseStartHash', () => {
  it('addresses a start by the frame that asked for it', () => {
    expect(startHash(SEVEN)).toBe('#/start/7');
    expect(parseStartHash('#/start/7')).toBe(7);
  });

  it('rejects a segment that is not a frame id', () => {
    expect(parseStartHash('#/start/x')).toBeNull();
    expect(parseStartHash('#/start/')).toBeNull();
    expect(parseStartHash('#/start/0')).toBeNull();
    expect(parseStartHash('#/start/-3')).toBeNull();
    // Number() would read each of these as 7 or 10; an address is the digits.
    expect(parseStartHash('#/start/7.0')).toBeNull();
    expect(parseStartHash('#/start/ 7')).toBeNull();
    expect(parseStartHash('#/start/1e1')).toBeNull();
    expect(parseStartHash('#/start/7/8')).toBeNull();
  });

  it('is not every other address', () => {
    expect(parseStartHash('')).toBeNull();
    expect(parseStartHash('#/')).toBeNull();
    expect(parseStartHash('#/session/store-work/session-1')).toBeNull();
  });
});
