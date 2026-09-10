import { describe, expect, it } from 'vitest';
import { closure, CLOSE_POLICY } from './message-socket.js';

/**
 * The byte limit is not invented here. Run against `ws` 8.21: a 123-byte close
 * reason is accepted, and 124 throws `RangeError: The message must not be
 * greater than 123 bytes`. It throws rather than truncating, which is why this
 * exists at all — the reason a socket closes for is assembled from a parser
 * message or a peer's words, and neither has a length anybody controls.
 */
const LIMIT = 123;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

describe('closure', () => {
  it('keeps a reason that fits', () => {
    expect(closure(CLOSE_POLICY, 'unauthorized')).toEqual({
      code: CLOSE_POLICY,
      reason: 'unauthorized',
    });
  });

  it('keeps a reason of exactly the limit, which a real socket accepts', () => {
    const reason = 'x'.repeat(LIMIT);
    expect(closure(CLOSE_POLICY, reason).reason).toBe(reason);
  });

  it('cuts a reason a byte over the limit, rather than letting the close throw', () => {
    expect(byteLength(closure(CLOSE_POLICY, 'x'.repeat(LIMIT + 1)).reason)).toBe(LIMIT);
  });

  it('cuts a very long reason down to something a socket will carry', () => {
    // A parser message quoting a malformed frame is the realistic source.
    expect(byteLength(closure(CLOSE_POLICY, 'a parse failure. '.repeat(50)).reason)).toBe(LIMIT);
  });

  it('counts bytes and not characters', () => {
    // 123 multi-byte characters is 369 bytes, and a limit measured in
    // characters would send every one of them at a socket that refuses it.
    const reason = 'é'.repeat(LIMIT);
    expect(byteLength(closure(CLOSE_POLICY, reason).reason)).toBeLessThanOrEqual(LIMIT);
  });

  it('cuts on a character boundary, so the reason is still readable', () => {
    const cut = closure(CLOSE_POLICY, 'é'.repeat(LIMIT)).reason;

    // Half a code point would decode as a replacement character, turning a
    // shortened message into a corrupted one.
    expect(cut).toBe('é'.repeat(cut.length));
    expect(cut).not.toContain('�');
  });

  it('does not cut an astral character in half either', () => {
    const cut = closure(CLOSE_POLICY, '\u{1F600}'.repeat(40)).reason;

    expect([...cut].every((character) => character === '\u{1F600}')).toBe(true);
    expect(byteLength(cut)).toBeLessThanOrEqual(LIMIT);
  });
});
