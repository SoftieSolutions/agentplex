import type { EmulatorSink } from './emulator.js';

/**
 * The path terminal bytes take through the client, and the buffer that lets a
 * late emulator catch up.
 *
 * Bytes arrive as chunks — each one whatever a single read delivered — and
 * flow straight to whatever emulator is attached. They never enter React
 * state: a snapshot that changed on every pty read would re-render the app at
 * output speed, and the only consumer of these bytes is the emulator anyway.
 * React's part is the ref-callback that attaches an emulator; this module is
 * where the bytes actually move.
 *
 * The buffer exists because an emulator attaches after output has been
 * flowing — the pane mounts, or remounts on navigation — and an emulator
 * given nothing opens on a blank screen. So recent chunks are kept, bounded,
 * and the bound is enforced by evicting WHOLE chunks, never by slicing one.
 * An ANSI escape sequence spans whatever chunk boundary it lands on, but it
 * never spans a boundary the producer did not make: a buffer cut at an exact
 * byte count can hand the emulator the tail of an escape, which it paints as
 * text, and the screen is wrong from the first character. Whole chunks cost
 * at most one chunk of memory over the cap and are always replayable. This is
 * the same rule, for the same reason, as the server's scrollback
 * (apps/agentplexd/src/server/scrollback.ts) — restated here because this
 * buffer trims independently.
 *
 * Nothing in here reads a byte. Terminal output is opaque to everything but
 * the emulator.
 */
export interface TerminalFeed {
  /** One chunk, exactly as it came off the wire. */
  push(chunk: Uint8Array): void;
  /**
   * Replays the buffered chunks into the sink, oldest first, then streams
   * every later push until the returned detach is called.
   */
  attach(sink: EmulatorSink): () => void;
  /** Bytes currently buffered. May exceed the cap by at most the newest chunk. */
  readonly bytes: number;
  /** Bytes evicted over this feed's life. */
  readonly dropped: number;
  /** Whether the beginning is gone, so the pane can say so instead of over-claiming. */
  readonly truncated: boolean;
}

export interface TerminalFeedOptions {
  /** The buffer cap, injected so a test can trim with three chunks. */
  readonly maxBytes: number;
}

/**
 * Enough for an emulator to repaint a busy screen several times over, small
 * enough that a dozen open panes cost tens of megabytes, not hundreds. The
 * server keeps the authoritative scrollback; this buffer only bridges the gap
 * between output arriving and an emulator attaching.
 */
export const DEFAULT_FEED_BYTES = 512 * 1024;

export function createTerminalFeed({ maxBytes }: TerminalFeedOptions): TerminalFeed {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let dropped = 0;
  const sinks = new Set<EmulatorSink>();

  return {
    push(chunk: Uint8Array): void {
      for (const sink of sinks) sink.write(chunk);

      // An empty chunk replays as nothing; keeping it would let a chatty
      // producer fill the buffer with entries that say nothing.
      if (chunk.byteLength === 0) return;

      chunks.push(chunk);
      bytes += chunk.byteLength;

      // `chunks.length > 1` is the whole-chunks rule meeting its edge: the
      // newest chunk survives even when it alone exceeds the cap, because
      // evicting it would leave nothing to replay and the next emulator asked
      // for recent output.
      while (bytes > maxBytes && chunks.length > 1) {
        const evicted = chunks.shift();
        if (evicted === undefined) break;
        bytes -= evicted.byteLength;
        dropped += evicted.byteLength;
      }
    },

    attach(sink: EmulatorSink): () => void {
      // Replay from a snapshot: a sink that pushes more output while being
      // written to must not see its own echo re-buffered mid-replay.
      for (const chunk of [...chunks]) sink.write(chunk);
      sinks.add(sink);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        sinks.delete(sink);
      };
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
