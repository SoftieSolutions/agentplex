import { terminalInputSchema, TERMINAL_INPUT_MAX_CHARS } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { chunkTerminalInput } from './terminal-input.js';

/**
 * The cut, held to three things: nothing is lost, nothing is reordered, and
 * every piece is a frame the protocol's own parser accepts. The last is why
 * the schema is imported rather than the number alone -- a test that only
 * compared lengths against the constant would agree with itself.
 */

/** Rejoined, which has to be the input again, character for character. */
function rejoin(pieces: readonly string[]): string {
  return pieces.join('');
}

describe('chunkTerminalInput', () => {
  it('sends nothing at all for nothing typed', () => {
    expect(chunkTerminalInput('')).toEqual([]);
  });

  it('leaves a keystroke as the one frame it is', () => {
    expect(chunkTerminalInput('a')).toEqual(['a']);
    // An arrow key, which is a sequence and not a character.
    expect(chunkTerminalInput('[A')).toEqual(['[A']);
  });

  it('leaves input of exactly the cap alone, since the cap is inclusive', () => {
    const exact = 'x'.repeat(TERMINAL_INPUT_MAX_CHARS);

    expect(chunkTerminalInput(exact)).toEqual([exact]);
    expect(terminalInputSchema.safeParse(exact).success).toBe(true);
  });

  it('cuts a longer paste into frames that rejoin to it, in order', () => {
    // Two and a bit frames, with distinguishable ends so a swap is visible.
    const paste = `head${'x'.repeat(TERMINAL_INPUT_MAX_CHARS * 2)}tail`;

    const pieces = chunkTerminalInput(paste);

    expect(pieces).toHaveLength(3);
    expect(rejoin(pieces)).toBe(paste);
    expect(pieces[0]?.startsWith('head')).toBe(true);
    expect(pieces.at(-1)?.endsWith('tail')).toBe(true);
    for (const piece of pieces) {
      expect(terminalInputSchema.safeParse(piece).success).toBe(true);
    }
  });

  it('keeps the markers of a bracketed paste at the ends they belong at', () => {
    // What the emulator hands over when the program at the far end asked for
    // bracketed paste: the cut falls in the middle of the pasted text, and the
    // opening and closing markers have to stay on the outside of everything.
    const wrapped = `[200~${'y'.repeat(TERMINAL_INPUT_MAX_CHARS + 10)}[201~`;

    const pieces = chunkTerminalInput(wrapped);

    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.startsWith('[200~')).toBe(true);
    expect(pieces[0]).not.toContain('[201~');
    expect(pieces.at(-1)?.endsWith('[201~')).toBe(true);
    expect(rejoin(pieces)).toBe(wrapped);
  });

  it('never cuts an emoji in half, which is what a lone surrogate would be', () => {
    // An astral character straddling the cap: one unit before the boundary is
    // the high half, so a naive slice would leave a lone surrogate at the end
    // of one frame and its partner at the start of the next. Neither is
    // encodable as UTF-8, so the process would receive two replacement
    // characters instead of the one character that was pasted.
    const paste = `${'z'.repeat(TERMINAL_INPUT_MAX_CHARS - 1)}\u{1F600}${'z'.repeat(10)}`;

    const pieces = chunkTerminalInput(paste);

    expect(rejoin(pieces)).toBe(paste);
    // The cut backed up by one unit, so the first frame ends on a plain 'z'
    // and the whole emoji starts the second.
    expect(pieces[0]).toHaveLength(TERMINAL_INPUT_MAX_CHARS - 1);
    expect(pieces[1]?.startsWith('\u{1F600}')).toBe(true);
    for (const piece of pieces) {
      // The round trip a lone surrogate does not survive: encoding to UTF-8 and
      // back is exactly what the wire does to these.
      expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece);
    }
  });
});
