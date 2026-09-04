import { describe, expect, it } from 'vitest';
import { createTerminalFeed } from './chunk-feed.js';
import type { EmulatorSink } from './emulator.js';
import { ptyChunks } from './pty-chunks.fixture.js';

/**
 * Driven with real pty output — chunk boundaries included — because the rule
 * under test exists for those boundaries. `pty-chunks.fixture.ts` is captured
 * from a real child on a real pty; see the capture test in apps/agentplexd.
 */

const ESCAPE = 0x1b;

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

function recordingSink(): EmulatorSink & { readonly written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    write(chunk: Uint8Array): void {
      written.push(chunk);
    },
  };
}

function feedOf(maxBytes: number) {
  const feed = createTerminalFeed({ maxBytes });
  for (const chunk of ptyChunks) feed.push(chunk);
  return feed;
}

describe('createTerminalFeed', () => {
  it('is tested against a capture that actually has boundaries and escapes', () => {
    // Guards the fixture, not the feed: if a re-capture ever came back as one
    // coalesced chunk or with no escape byte, every test below would still
    // pass while proving nothing about the rule.
    expect(ptyChunks.length).toBeGreaterThan(3);
    expect(ptyChunks.some((chunk) => chunk.includes(ESCAPE))).toBe(true);
  });

  it('replays everything, in order, when the cap was never reached', () => {
    const feed = feedOf(1024 * 1024);
    const sink = recordingSink();

    feed.attach(sink);

    expect(concat(sink.written)).toEqual(concat(ptyChunks));
    expect(feed.truncated).toBe(false);
    expect(feed.dropped).toBe(0);
  });

  it('trims by evicting whole chunks, so the replay starts on a boundary the pty made', () => {
    const total = concat(ptyChunks).byteLength;
    const cap = Math.floor(total / 2);
    const feed = feedOf(cap);
    const sink = recordingSink();

    feed.attach(sink);

    // The retained tail is byte-for-byte a suffix of the full stream, and its
    // start coincides with a real chunk boundary: some whole-chunk suffix of
    // the fixture concatenates to exactly what was replayed.
    const replayed = concat(sink.written);
    const suffixes = ptyChunks.map((_, from) => concat(ptyChunks.slice(from)));
    expect(suffixes.map((s) => s.byteLength)).toContain(replayed.byteLength);
    expect(concat(ptyChunks).slice(total - replayed.byteLength)).toEqual(replayed);
    expect(feed.truncated).toBe(true);
    expect(feed.dropped + feed.bytes).toBe(total);
  });

  it('never hands out the tail of a split escape sequence', () => {
    // The sharpest form of the rule: whatever the cap, a replay either starts
    // clean of any dropped chunk or contains that chunk whole. A byte-exact
    // trim would fail this on the fixture's long SGR run.
    const total = concat(ptyChunks).byteLength;
    for (let cap = 1; cap < total; cap += 97) {
      const feed = feedOf(cap);
      const sink = recordingSink();
      feed.attach(sink);
      for (const written of sink.written) {
        expect(
          ptyChunks.some(
            (chunk) =>
              concat([chunk]).length === written.length &&
              chunk.every((byte, i) => byte === written[i]),
          ),
        ).toBe(true);
      }
    }
  });

  it('keeps the newest chunk even when it alone is over the cap', () => {
    const feed = feedOf(1);
    const sink = recordingSink();

    feed.attach(sink);

    const last = ptyChunks[ptyChunks.length - 1];
    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]).toEqual(last);
    expect(feed.bytes).toBe(last?.byteLength);
  });

  it('streams live chunks to an attached sink and stops on detach', () => {
    const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
    const sink = recordingSink();
    const [first, second, third] = ptyChunks;
    if (first === undefined || second === undefined || third === undefined) throw new Error();

    feed.push(first);
    const detach = feed.attach(sink);
    feed.push(second);
    detach();
    feed.push(third);

    expect(sink.written).toEqual([first, second]);
  });

  it('detaching twice detaches nobody else', () => {
    const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
    const gone = recordingSink();
    const staying = recordingSink();
    const chunk = ptyChunks[0];
    if (chunk === undefined) throw new Error();

    const detach = feed.attach(gone);
    feed.attach(staying);
    detach();
    detach();
    feed.push(chunk);

    expect(gone.written).toEqual([]);
    expect(staying.written).toEqual([chunk]);
  });

  it('drops empty chunks rather than buffering entries that replay as nothing', () => {
    const feed = createTerminalFeed({ maxBytes: 1024 });

    feed.push(new Uint8Array(0));

    const sink = recordingSink();
    feed.attach(sink);
    expect(sink.written).toEqual([]);
    expect(feed.bytes).toBe(0);
  });
});
