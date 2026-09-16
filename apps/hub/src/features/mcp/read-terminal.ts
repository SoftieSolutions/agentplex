import {
  decodeTerminalChunk,
  type ClientTerminalTarget,
  type FrameId,
  type HubFrame,
} from '@agentplex/protocol';
import type { Timers } from '@agentplex/node-shared';
import { z } from 'zod';
import type { TerminalClient } from '../terminal/terminal.js';
import { parsedSessionRef } from './session-args.js';
import {
  answers,
  defineMcpTool,
  readOnly,
  refuses,
  type McpAnswer,
  type McpTool,
} from './tool-registry.js';

/**
 * The recent output of one session, as text, bounded.
 *
 * ## This is the one place terminal bytes are decoded, and it is deliberate
 *
 * Everywhere else in this system terminal output is opaque. The server
 * re-encodes what the pty gave it, the hub relays the same characters
 * untouched, and the browser hands them to an emulator -- `protocol/terminal.ts`
 * and `terminal/terminal.ts` both carry the argument, which is that anything in
 * between that decoded and re-encoded would turn a chunk boundary inside a code
 * point into a replacement character and a drawn box into rubble.
 *
 * This tool decodes them, and the reason is that the consumer has changed. A
 * model reading a transcript *is* the thing the bytes were produced for: there
 * is no emulator downstream, no second encode, and nothing that could render an
 * escape sequence. Handing an agent base64 would be handing it the problem. So
 * the bytes stop here, and they stop here honestly: invalid sequences become
 * U+FFFD rather than an error, because a window that begins mid-code-point is
 * the normal case and not a fault.
 *
 * ## What it reads, and what it does not
 *
 * The scrollback the holding server already keeps, once. It subscribes through
 * the relay as an ordinary client, takes the replay the subscription promised,
 * and detaches. There is no live streaming and there will not be one on this
 * endpoint: a call returns what exists now, because this transport is stateless
 * -- `mcp.ts` says why -- and a tool that streamed would be the ticket that
 * argues for sessions rather than something smuggled in under a read tool.
 *
 * ## Its own client identity, per call
 *
 * The relay keys watches by client object, and refuses a second subscription to
 * one terminal from one client -- correctly, because a second subscribe asks
 * for a second replay. So each call builds its own `TerminalClient` and gives
 * it back when it is done. Two agents reading one session at once are two
 * clients, which is what they are, and neither can be handed the other's
 * history.
 */

/**
 * How much output a caller gets when it does not say.
 *
 * A screen is a couple of kilobytes and a compile that just failed is tens; 16
 * KiB is the last few screens, which is the window that answers "what is it
 * waiting for" without costing a context window.
 */
export const READ_TERMINAL_DEFAULT_MAX_BYTES = 16 * 1024;

/** The most any one call may ask for, however large a number it names. */
export const READ_TERMINAL_MAX_BYTES = 256 * 1024;

/**
 * How long the replay has to arrive.
 *
 * It crosses two legs -- hub to server, and the server's scrollback back --
 * and the hub is the end that dialled, so a machine that has gone quiet mid
 * answer is a wait nothing else will end. Long enough for a slow link with a
 * large scrollback, short enough that an agent gets a sentence rather than a
 * call that never returns.
 */
export const READ_TERMINAL_TIMEOUT_MS = 10_000;

/**
 * The frame id this tool subscribes under.
 *
 * A frame id is unique within one connection, and this client *is* one
 * connection: it is built for one call, sends one subscribe and is forgotten.
 * There is nothing for it to collide with.
 */
const ONLY_FRAME: FrameId = 1;

/**
 * What this tool needs of the relay.
 *
 * Two methods of `Terminal`, which is every method a reader needs and no method
 * that writes: there is no path from here to `input`, to `resize` or to a
 * start. A tool that took the whole feature would be a tool that could grow one
 * without a review noticing.
 *
 * `forget` and not `unsubscribe` is the detach, and it is the stronger of the
 * two. `unsubscribe` gives one watch back; `forget` gives every watch back
 * *and* drops the client from the relay's books -- which matters here, because
 * a client object that is never coming back would otherwise be left as a key in
 * a map for the life of the hub, one per call. It is the same release path a
 * closing socket takes, which is exactly what this client is doing.
 */
export interface TerminalReads {
  subscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void;
  forget(client: TerminalClient): void;
}

export interface ReadTerminalDependencies {
  readonly terminal: TerminalReads;
  /** The deadline seam. Injected for the reason every clock here is: a test cannot wait ten seconds. */
  readonly timers: Timers;
}

export function readTerminalTool({ terminal, timers }: ReadTerminalDependencies): McpTool {
  return defineMcpTool({
    name: 'read_terminal',
    description:
      'Reads the recent terminal output of one session as text. Returns what exists now; it does not stream.',
    input: {
      storeId: z.string().describe('The store the session is filed under.'),
      sessionId: z.string().describe('The session id, as list_sessions returns it.'),
      maxBytes: z
        .int()
        .min(1)
        .max(READ_TERMINAL_MAX_BYTES)
        .default(READ_TERMINAL_DEFAULT_MAX_BYTES)
        .describe(
          `How many bytes from the end of the scrollback to return. Defaults to ${String(READ_TERMINAL_DEFAULT_MAX_BYTES)}, at most ${String(READ_TERMINAL_MAX_BYTES)}.`,
        ),
    },
    output: {
      storeId: z.string(),
      sessionId: z.string(),
      text: z
        .string()
        .describe(
          'The output, decoded as UTF-8 with invalid sequences replaced. Escape sequences are left in: they are what the program wrote.',
        ),
      bytes: z.int().describe('How many bytes the returned text was decoded from.'),
      truncated: z
        .boolean()
        .describe('Whether older output was cut to fit maxBytes. What is returned is the end.'),
      droppedBytes: z
        .int()
        .describe(
          'How much the session printed before the scrollback this hub was replayed begins. Zero means this is the session from its first byte.',
        ),
    },
    annotations: readOnly,
    render: (value) => value.text,
    run: async ({ storeId, sessionId, maxBytes }) => {
      // Parsed rather than asserted, and parsed where every session tool parses
      // one: these arrive off an MCP client as two strings, the relay addresses
      // a terminal by two branded ids, and the sentence a bad one is refused
      // with is the same sentence whichever tool was called. `session-args.ts`
      // carries the argument.
      const ref = parsedSessionRef(storeId, sessionId);
      if (!ref.ok) return ref;

      const target: ClientTerminalTarget = { by: 'session', ...ref.value };

      const replayed = await replayOf(terminal, timers, target);
      if (!replayed.ok) return replayed;

      const kept = lastWholeChunks(replayed.value.chunks, maxBytes);
      return answers({
        storeId,
        sessionId,
        text: asText(kept.chunks),
        bytes: kept.bytes,
        truncated: kept.chunks.length < replayed.value.chunks.length,
        droppedBytes: replayed.value.droppedBytes,
      });
    },
  });
}

/** One subscription's history: the chunks it promised, and what it had already lost. */
interface Replay {
  readonly chunks: readonly Uint8Array[];
  readonly droppedBytes: number;
}

/**
 * Subscribes, takes the history, detaches.
 *
 * The completion condition is the count on the subscription's own reply.
 * `session-subscribed` says how many `terminal-output` frames of history follow
 * it, and nothing else on the wire distinguishes history from live output --
 * they are the same frame -- so that number is the only thing that can say when
 * the replay is done. A subscription answered with zero is done immediately,
 * which is a session that has printed nothing yet rather than an error.
 *
 * Every refusal the relay can produce arrives here as a `refusal` frame and
 * leaves as the sentence it carried: a store nobody has mounted, a session no
 * connected machine reports, a server that declined the subscribe. None of them
 * is this tool's to word, and each of them already names the machine -- which
 * is the difference between an agent that knows a laptop is asleep and an agent
 * looking at an empty string.
 */
async function replayOf(
  terminal: TerminalReads,
  timers: Timers,
  target: ClientTerminalTarget,
): Promise<McpAnswer<Replay>> {
  const chunks: Uint8Array[] = [];
  let droppedBytes = 0;
  let expected: number | null = null;
  let done = false;

  // Assigned by the executor below, which runs synchronously, and defaulted so
  // that this is a binding rather than a promise about one. The relay can
  // refuse inside `subscribe` itself, in the same turn, so `settle` has to
  // already be the real one by then.
  let settle: (answer: McpAnswer<Replay>) => void = () => {};
  const replay = new Promise<McpAnswer<Replay>>((resolve) => {
    settle = resolve;
  });

  const finish = (): void => {
    done = true;
    settle({ ok: true, value: { chunks, droppedBytes } });
  };

  const client: TerminalClient = {
    // Nothing is buffered: this client is a function call, and the relay reads
    // this to decide whether a socket is too far behind to be sent live output.
    // There is no socket and there is no live output being waited for.
    bufferedBytes: 0,
    send(frame: HubFrame): void {
      if (done) return;
      switch (frame.type) {
        case 'refusal':
          done = true;
          settle(refuses(frame.message));
          return;
        case 'session-subscribed':
          droppedBytes = frame.droppedBytes;
          expected = frame.replayChunks;
          if (chunks.length >= expected) finish();
          return;
        case 'terminal-output':
          chunks.push(decodeTerminalChunk(frame.chunk));
          if (expected !== null && chunks.length >= expected) finish();
          return;
        default:
          // Everything else the hub can put to a client -- a welcome, a machine
          // state, a detach acknowledgement -- is not an answer to this
          // subscription. Ignored rather than switched exhaustively: this is
          // one frame's worth of interest in a union that belongs to the client
          // connection, and a case per frame here would be a second reader of
          // that union to keep in step.
          return;
      }
    },
  };

  const cancel = timers.schedule(READ_TERMINAL_TIMEOUT_MS, () => {
    if (done) return;
    done = true;
    settle(
      refuses(
        `the machine holding that session did not answer within ${String(READ_TERMINAL_TIMEOUT_MS)}ms`,
      ),
    );
  });

  try {
    terminal.subscribe(client, ONLY_FRAME, target);
    return await replay;
  } finally {
    cancel();
    terminal.forget(client);
  }
}

/** The tail of the history that fits, and how many bytes that turned out to be. */
interface Kept {
  readonly chunks: readonly Uint8Array[];
  readonly bytes: number;
}

/**
 * The last `maxBytes` of output, cut on chunk boundaries.
 *
 * Whole chunks, never part of one, and that is the same rule every other
 * bounded thing on this path follows: the server drops whole chunks when a
 * reader falls behind, and the relay counts whole chunks. Cutting inside a
 * chunk would mean cutting inside an escape sequence, and the first line of the
 * answer would be the tail of a colour code.
 *
 * The one case where the boundary wins over the bound: a single chunk larger
 * than `maxBytes` is returned whole rather than dropped, because the
 * alternative is answering a question about a busy session with nothing at all.
 * It is bounded anyway -- `TERMINAL_CHUNK_MAX_CHARS` caps one chunk on the wire
 * -- and `bytes` says what actually came back, so a caller is never guessing.
 */
function lastWholeChunks(chunks: readonly Uint8Array[], maxBytes: number): Kept {
  const kept: Uint8Array[] = [];
  let bytes = 0;

  for (let at = chunks.length - 1; at >= 0; at -= 1) {
    const chunk = chunks[at];
    if (chunk === undefined) continue;
    if (kept.length > 0 && bytes + chunk.length > maxBytes) break;
    kept.unshift(chunk);
    bytes += chunk.length;
    if (bytes >= maxBytes) break;
  }

  return { chunks: kept, bytes };
}

/**
 * The bytes as text.
 *
 * A non-fatal decoder, which is the whole point: a window onto the middle of a
 * stream begins wherever the trim put it, and a chunk the pty split inside a
 * code point ends there too. Both are ordinary, and both become U+FFFD rather
 * than a failed call.
 */
function asText(chunks: readonly Uint8Array[]): string {
  let bytes = 0;
  for (const chunk of chunks) bytes += chunk.length;

  const whole = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }

  return new TextDecoder().decode(whole);
}
