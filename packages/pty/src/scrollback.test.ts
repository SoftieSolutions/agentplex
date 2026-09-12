import { describe, expect, it } from 'vitest';
import { createScrollback } from './scrollback.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** What a reader would see if it replayed the buffer into an emulator. */
function replay(chunks: readonly Uint8Array[]): string {
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
}

describe('createScrollback', () => {
  it('keeps everything that fits, in the order it arrived', () => {
    const scrollback = createScrollback({ maxBytes: 64 });

    scrollback.append(bytes('one'));
    scrollback.append(bytes('two'));

    expect(replay(scrollback.chunks())).toBe('onetwo');
    expect(scrollback.bytes).toBe(6);
    expect(scrollback.dropped).toBe(0);
  });

  it('drops whole chunks off the front, never part of one', () => {
    // The rule the spec states and the reason it exists: a chunk is a read off
    // the pty, and an escape sequence spans it wherever it happens to land.
    // Trimming to a byte count would leave a reader starting mid-sequence, and
    // an emulator fed half a CSI paints the rest of the screen as garbage.
    const scrollback = createScrollback({ maxBytes: 10 });

    scrollback.append(bytes('aaaa'));
    scrollback.append(bytes('bbbb'));
    scrollback.append(bytes('cccc'));

    expect(replay(scrollback.chunks())).toBe('bbbbcccc');
    expect(scrollback.bytes).toBe(8);
    expect(scrollback.dropped).toBe(4);
  });

  it('drops as many whole chunks as it takes to get under the cap', () => {
    const scrollback = createScrollback({ maxBytes: 6 });

    scrollback.append(bytes('aa'));
    scrollback.append(bytes('bb'));
    scrollback.append(bytes('cc'));
    scrollback.append(bytes('dddddd'));

    expect(replay(scrollback.chunks())).toBe('dddddd');
    expect(scrollback.dropped).toBe(6);
  });

  it('keeps a single chunk that is larger than the cap rather than splitting it', () => {
    // The cap is a target the buffer may exceed by one chunk, and that is the
    // honest reading of "whole chunks only". The alternative — dropping the
    // only chunk there is — would answer a request for recent output with
    // nothing at all, which is the one answer that is certainly wrong.
    const scrollback = createScrollback({ maxBytes: 4 });

    scrollback.append(bytes('aaaaaaaaaaaa'));

    expect(replay(scrollback.chunks())).toBe('aaaaaaaaaaaa');
    expect(scrollback.dropped).toBe(0);
  });

  it('tells a session that has produced nothing from one whose beginning is gone', () => {
    // The two opposite facts a pane must never render identically. Both hold a
    // buffer that is not the whole session, and the only thing separating them
    // is this number: nothing has been thrown away, or this much has.
    const silent = createScrollback({ maxBytes: 4 });
    const busy = createScrollback({ maxBytes: 4 });

    busy.append(bytes('aaaa'));
    busy.append(bytes('bbbb'));

    expect(silent.chunks()).toEqual([]);
    expect(silent.dropped).toBe(0);
    expect(busy.chunks()).toHaveLength(1);
    expect(busy.dropped).toBe(4);
  });

  it('counts every dropped byte, not merely that some were dropped', () => {
    // A boolean says "the beginning is gone". This says how much of it, which
    // is the difference between a pane that admits a gap and one that can size
    // it. It only ever rises: it is this buffer's whole life, not one eviction.
    const scrollback = createScrollback({ maxBytes: 6 });

    scrollback.append(bytes('aaaa'));
    scrollback.append(bytes('bbbb'));
    expect(scrollback.dropped).toBe(4);

    scrollback.append(bytes('cccccc'));
    expect(scrollback.dropped).toBe(8);
  });

  it('ignores an empty chunk instead of filling the buffer with nothing', () => {
    const scrollback = createScrollback({ maxBytes: 4 });

    scrollback.append(new Uint8Array(0));

    expect(scrollback.chunks()).toEqual([]);
  });

  it('hands out a snapshot a later write cannot change underneath the reader', () => {
    const scrollback = createScrollback({ maxBytes: 64 });
    scrollback.append(bytes('one'));

    const taken = scrollback.chunks();
    scrollback.append(bytes('two'));

    expect(replay(taken)).toBe('one');
  });
});
