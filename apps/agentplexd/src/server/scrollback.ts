/**
 * A bounded replay buffer of raw terminal output.
 *
 * A client that attaches to a running session has to be given the recent past
 * or it opens on a blank screen, and the session may have been printing for
 * hours. So the server keeps a window, and the only question is how it throws
 * the rest away.
 *
 * It throws away whole chunks. A chunk is one read off the pty and an escape
 * sequence spans whatever boundary it lands on, so a buffer trimmed to an exact
 * byte count hands the next reader a stream starting mid-sequence — the
 * emulator paints the remainder of that sequence as text and the screen is
 * wrong from the first character. Whole chunks cost a little more memory than
 * the cap says and are always replayable. That is the trade, and it is why the
 * spec states the rule rather than leaving it to whoever writes the buffer.
 *
 * Nothing in here looks at a byte. Terminal output is opaque: it is counted and
 * forwarded and never parsed, because the only thing that understands it is the
 * emulator in the browser.
 */
export interface Scrollback {
  append(chunk: Uint8Array): void;
  /** A snapshot. Later output cannot change what a reader is already replaying. */
  chunks(): readonly Uint8Array[];
  /** Bytes currently held. May exceed the cap by at most the newest chunk. */
  readonly bytes: number;
  /** Bytes dropped over this buffer's life. */
  readonly dropped: number;
  /**
   * Whether anything was dropped, so a reader can say "the beginning is gone"
   * rather than presenting a tail as the whole session.
   */
  readonly truncated: boolean;
}

export interface ScrollbackOptions {
  readonly maxBytes: number;
}

export function createScrollback({ maxBytes }: ScrollbackOptions): Scrollback {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let dropped = 0;

  return {
    append(chunk: Uint8Array): void {
      // Not an error, and not worth a slot: node-pty can deliver one when a
      // read returns nothing, and keeping them would let a chatty pty fill the
      // buffer with entries that replay as nothing.
      if (chunk.byteLength === 0) return;

      chunks.push(chunk);
      bytes += chunk.byteLength;

      // `chunks.length > 1` is the whole-chunks rule: the newest chunk is
      // never dropped even when it alone is over the cap. Dropping it would
      // answer with an empty buffer, and the caller asked for recent output.
      while (bytes > maxBytes && chunks.length > 1) {
        const evicted = chunks.shift();
        if (evicted === undefined) break;
        bytes -= evicted.byteLength;
        dropped += evicted.byteLength;
      }
    },

    chunks(): readonly Uint8Array[] {
      return [...chunks];
    },

    get bytes(): number {
      return bytes;
    },

    get dropped(): number {
      return dropped;
    },

    get truncated(): boolean {
      return dropped > 0;
    },
  };
}
