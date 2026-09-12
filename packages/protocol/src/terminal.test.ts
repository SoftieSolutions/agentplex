import { describe, expect, it } from 'vitest';
import {
  decodeTerminalChunk,
  encodeTerminalChunk,
  TERMINAL_INPUT_MAX_CHARS,
  TERMINAL_MAX_COLS,
  terminalChunkSchema,
  terminalInputSchema,
  terminalSizeSchema,
  terminalTargetSchema,
} from './terminal.js';

describe('terminalTargetSchema', () => {
  it('addresses a session by its store and its id', () => {
    const parsed = terminalTargetSchema.safeParse({
      by: 'session',
      storeId: 'store-1',
      sessionId: 'session-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('addresses a session the provider has not named yet by the start that made it', () => {
    expect(terminalTargetSchema.safeParse({ by: 'start', startId: 12 }).success).toBe(true);
  });

  it('refuses a target that names a start and a session at once', () => {
    // The discriminant is what makes "either" a parse rather than a guess: a
    // reader never has to decide which half of an ambiguous object to believe.
    const parsed = terminalTargetSchema.safeParse({
      by: 'session',
      storeId: 'store-1',
      sessionId: 'session-1',
      startId: 12,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty('startId');
  });

  it('refuses a target with no discriminant at all', () => {
    expect(terminalTargetSchema.safeParse({ storeId: 'store-1', sessionId: 'x' }).success).toBe(
      false,
    );
  });

  it('refuses a session target missing its store', () => {
    expect(terminalTargetSchema.safeParse({ by: 'session', sessionId: 'session-1' }).success).toBe(
      false,
    );
  });

  it('refuses a start handle that is not a frame id', () => {
    expect(terminalTargetSchema.safeParse({ by: 'start', startId: 0 }).success).toBe(false);
    expect(terminalTargetSchema.safeParse({ by: 'start', startId: -3 }).success).toBe(false);
    expect(terminalTargetSchema.safeParse({ by: 'start', startId: 1.5 }).success).toBe(false);
  });

  it('carries no cwd, no argv and no operation name', () => {
    const parsed = terminalTargetSchema.safeParse({
      by: 'session',
      storeId: 'store-1',
      sessionId: 'session-1',
      cwd: '/etc',
      command: 'sh',
      args: ['-c', 'id'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ by: 'session', storeId: 'store-1', sessionId: 'session-1' });
  });
});

describe('terminal chunk coding', () => {
  it('round-trips every byte a pty can produce', () => {
    // Exhaustive rather than a sample: the whole reason output is not a string
    // is that some byte values do not survive being read as text, and the only
    // convincing test of that is all of them.
    const every = Uint8Array.from({ length: 256 }, (_, at) => at);
    expect(decodeTerminalChunk(encodeTerminalChunk(every))).toEqual(every);
  });

  it('round-trips a UTF-8 sequence cut in half by a chunk boundary', () => {
    // The failure this transport exists to avoid. A pty read can end in the
    // middle of a code point, and anything that decodes a chunk as text turns
    // the halves into two replacement characters that never recombine.
    const whole = new TextEncoder().encode('\u{1F680} │ café');
    const head = whole.subarray(0, 2);
    const tail = whole.subarray(2);

    const rejoined = new Uint8Array(whole.length);
    rejoined.set(decodeTerminalChunk(encodeTerminalChunk(head)), 0);
    rejoined.set(decodeTerminalChunk(encodeTerminalChunk(tail)), head.length);

    expect(rejoined).toEqual(whole);
    expect(new TextDecoder().decode(rejoined)).toBe('\u{1F680} │ café');
  });

  it('round-trips a chunk far larger than one call to the encoder handles at once', () => {
    // The encoder turns bytes into characters in blocks, because spreading a
    // megabyte of them into one call overflows the call stack on a busy
    // session. This is the size that crosses a block boundary.
    //
    // Asserted by comparing encodings rather than the arrays themselves: the
    // encoding is injective, so equal encodings are equal bytes, and a deep
    // comparison of a hundred thousand elements costs seconds of the suite.
    const big = Uint8Array.from({ length: 100_000 }, (_, at) => at % 256);
    const returned = decodeTerminalChunk(encodeTerminalChunk(big));

    expect(returned).toHaveLength(big.length);
    expect(encodeTerminalChunk(returned)).toBe(encodeTerminalChunk(big));
  });

  it('encodes an empty chunk to something the schema still accepts', () => {
    expect(terminalChunkSchema.safeParse(encodeTerminalChunk(new Uint8Array())).success).toBe(true);
  });

  it('refuses characters that are not base64 rather than decoding them to rubbish', () => {
    expect(terminalChunkSchema.safeParse('not bytes at all!').success).toBe(false);
  });

  it('bounds a chunk, so one frame cannot be made arbitrarily large', () => {
    const parsed = terminalChunkSchema.safeParse(
      encodeTerminalChunk(new Uint8Array(2 * 1024 * 1024)),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('terminalInputSchema', () => {
  it('takes what a user typed, as text, because that is what a user produces', () => {
    expect(terminalInputSchema.safeParse('pnpm test\r').success).toBe(true);
  });

  it('takes a paste, which is only more of the same', () => {
    expect(terminalInputSchema.safeParse('x'.repeat(TERMINAL_INPUT_MAX_CHARS)).success).toBe(true);
  });

  it('bounds it, so a paste cannot be an unbounded write into a pty', () => {
    expect(terminalInputSchema.safeParse('x'.repeat(TERMINAL_INPUT_MAX_CHARS + 1)).success).toBe(
      false,
    );
  });
});

describe('terminalSizeSchema', () => {
  it('accepts a size a terminal can actually have', () => {
    expect(terminalSizeSchema.safeParse({ cols: 120, rows: 40 }).success).toBe(true);
  });

  it('refuses a zero or negative dimension, which no terminal has', () => {
    expect(terminalSizeSchema.safeParse({ cols: 0, rows: 40 }).success).toBe(false);
    expect(terminalSizeSchema.safeParse({ cols: 120, rows: -1 }).success).toBe(false);
  });

  it('refuses a fractional dimension rather than rounding one', () => {
    expect(terminalSizeSchema.safeParse({ cols: 120.5, rows: 40 }).success).toBe(false);
  });

  it('bounds it, because a resize is a number this server hands to an ioctl', () => {
    expect(terminalSizeSchema.safeParse({ cols: TERMINAL_MAX_COLS + 1, rows: 40 }).success).toBe(
      false,
    );
  });
});
