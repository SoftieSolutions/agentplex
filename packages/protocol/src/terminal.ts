import { z } from 'zod';
import { frameIdSchema } from './frames.js';
import { sessionIdSchema, storeIdSchema } from './identity.js';

/**
 * Terminal frames: the bytes a session produces, the keystrokes it is given,
 * and the standing interest that connects the two.
 *
 * They live here rather than in `client.ts` or `server.ts` because they are the
 * one part of the protocol that is relayed rather than answered. A client
 * subscribes to a session, the hub subscribes to the server holding it, and the
 * chunk that comes back travels both legs unchanged; two copies of these shapes
 * would be two things to keep in step for no gain, and the day they drifted the
 * symptom would be a terminal that renders almost right.
 *
 * Each direction still owns exactly one parser. `client.ts` and `server.ts`
 * put these schemas into their own unions, and nothing downstream re-checks a
 * `type` the union already decided.
 *
 * ## Why output rides a JSON frame
 *
 * Terminal output is bytes and never text -- `pty.ts` says why, and this module
 * does not undo it -- but it travels as base64 inside the same JSON frames as
 * everything else, rather than on a binary websocket message.
 *
 * The socket seam carries text, by an argument already made in
 * `message-socket.ts`: every frame is JSON, so nothing downstream has to decide
 * how to read one. A binary path would need a second seam on both roles, a
 * second framing to say which terminal a buffer belongs to, and therefore a
 * second parser per direction -- which is the rule this protocol is built on,
 * spent on a transport detail. Base64 keeps one parser, one socket seam and one
 * refusal path, and it is lossless: the bytes are re-encoded, never decoded, so
 * a chunk that ends mid-code-point arrives as the same half a code point.
 *
 * What it costs is a third more bytes on the busiest path, and that is the
 * trade taken deliberately. It is bounded by the same thing the wire is bounded
 * by -- a chunk cap here and, when AGX-209 lands, dropped chunks counted on the
 * frame -- and moving to a binary channel later is a protocol version bump and
 * two encoders, not a redesign.
 */

/**
 * Which terminal a frame is about.
 *
 * A session's identity is `{ storeId, sessionId }`, and that is the ordinary
 * way to name one. The other way exists because of the gap at the start of a
 * spawn: the provider mints its own session id and writes it moments after the
 * process is up, so between the fork and the first scan there is a live
 * terminal producing output and no session id to address it by. The start
 * handle -- the id of the `session-start` frame that asked for it -- is the
 * name that exists in that gap, which is what lets a pending pane show a real
 * terminal while the provider is still starting.
 *
 * A discriminated union rather than two optional fields, so that "either" is
 * something a parser decides and not something a reader guesses. An object
 * carrying both would otherwise be a frame whose meaning depends on which
 * field the receiver happens to check first.
 *
 * There is no terminal id here, and there is nowhere to put one. A terminal id
 * is the server's own bookkeeping for a process on its own machine, and a peer
 * that could name one could name any of them.
 */
export const terminalTargetSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('session'),
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  z.object({
    by: z.literal('start'),
    /**
     * The id of the `session-start` frame that asked for this session, on the
     * connection that asked. It is local to that connection and means nothing
     * on another one, which is why it never identifies a session: it is a
     * handle on one act of starting, and it stops being useful the moment the
     * session has a name of its own.
     */
    startId: frameIdSchema,
  }),
]);
export type TerminalTarget = z.infer<typeof terminalTargetSchema>;

/**
 * The cap on one chunk of output, in base64 characters.
 *
 * A chunk is one read off a pty, which is tens of kilobytes at the very most;
 * this is far above that and still small enough that no single frame can be
 * made into a memory problem by a peer that is lying about what it read.
 */
export const TERMINAL_CHUNK_MAX_CHARS = 1_400_000;

/** Raw terminal output, base64. Never decoded as text by anything, anywhere. */
export const terminalChunkSchema = z.base64().max(TERMINAL_CHUNK_MAX_CHARS);

/**
 * The cap on one write into a pty.
 *
 * The same bound `paneLayoutTextSchema` uses, for the same reason: it is far
 * more than a person types or pastes in one go, and an unbounded field filled
 * by a bug would grow without anything ever objecting. A client with more than
 * this to send sends it as more than one frame.
 */
export const TERMINAL_INPUT_MAX_CHARS = 65_536;

/**
 * Keystrokes, as text.
 *
 * Text here and bytes in the other direction, and the asymmetry is real rather
 * than an oversight: input is what a person produced, which is characters, and
 * the pty seam takes a string. Output is what a program produced, which is a
 * stream of escape sequences and half code points that only an emulator reads.
 * A paste is neither an exception nor a new frame -- the bytes a user pastes
 * are the bytes a user typed.
 */
export const terminalInputSchema = z.string().max(TERMINAL_INPUT_MAX_CHARS);

/** Larger than any real terminal, small enough that no peer can name a silly one. */
export const TERMINAL_MAX_COLS = 1_000;
export const TERMINAL_MAX_ROWS = 1_000;

/**
 * How big the client's terminal actually is.
 *
 * Resize is the one thing on the copy/paste/select/scroll list that genuinely
 * crosses the wire. Selection and copy happen entirely in the browser's
 * emulator and this protocol has no notion of a selection; paste is input;
 * scroll is scrollback. A size, though, is a fact about the viewer that the
 * process on the other machine has to be told, because the agent lays its
 * screen out against it.
 */
export const terminalSizeSchema = z.object({
  cols: z.int().min(1).max(TERMINAL_MAX_COLS),
  rows: z.int().min(1).max(TERMINAL_MAX_ROWS),
});
export type TerminalSize = z.infer<typeof terminalSizeSchema>;

/**
 * Standing interest in one terminal's output.
 *
 * It is a frame rather than a side effect of opening something, and it has a
 * partner below, because the count it moves is the one eviction reads. A
 * subscribe with no unsubscribe would leave the server's "how many are
 * watching this" only ever growing, and the longest-unwatched rule would be
 * choosing between terminals that all claim to be watched.
 */
export const sessionSubscribeFrameSchema = z.object({
  type: z.literal('session-subscribe'),
  id: frameIdSchema,
  target: terminalTargetSchema,
});

/**
 * Stops watching a session without stopping it.
 *
 * The partner of `session-subscribe`, and the whole difference between closing
 * a tab and killing an agent. Detaching never closes a terminal: sessions
 * outlive tabs and sockets, a lid closing is not a decision, and an agent
 * mid-work goes on working with nobody watching.
 */
export const sessionUnsubscribeFrameSchema = z.object({
  type: z.literal('session-unsubscribe'),
  id: frameIdSchema,
  target: terminalTargetSchema,
});

/**
 * Keystrokes for a session.
 *
 * Answered only when it fails. Every other frame here gets a reply, and this
 * one does not, because a terminal already acknowledges input the way terminals
 * do -- it echoes it -- and an acknowledgement per keystroke would double the
 * frame rate of the busiest path on the wire to restate what is already on the
 * user's screen. A write that could not be delivered is refused, naming this
 * frame, which is the case a user cannot see for themselves.
 */
export const terminalInputFrameSchema = z.object({
  type: z.literal('terminal-input'),
  id: frameIdSchema,
  target: terminalTargetSchema,
  data: terminalInputSchema,
});

/** The viewer's size, for the pty to be resized to. Refused only when it fails. */
export const terminalResizeFrameSchema = z.object({
  type: z.literal('terminal-resize'),
  id: frameIdSchema,
  target: terminalTargetSchema,
  size: terminalSizeSchema,
});

/**
 * The subscription is attached, and here is what it is attached to.
 *
 * It names both `sessionId` and `startId`, whichever the subscription used,
 * because the answer to "which terminal did I just attach to" is the pair: a
 * subscription made by start handle is answered with a `sessionId` of `null`
 * until the provider names the session, and one made by session is answered
 * with the start handle when this connection is the one that started it.
 *
 * ## What a client is given on attach, and what it is told about it
 *
 * A subscription to a session that has been running an hour is answered with a
 * bounded tail of what it printed -- the scrollback the server already keeps,
 * replayed on `terminal-output` frames that follow this one. Not everything,
 * because a server holds a pty and not a recording; not nothing, because a
 * pane that opens blank on a busy agent is useless.
 *
 * A tail is not the session, so this frame carries the two numbers that keep a
 * pane from claiming it is.
 *
 * `replayChunks` is how many `terminal-output` frames of history follow this
 * one, after which the stream is live. The socket is ordered and the replay is
 * written in the same turn as this reply, so the count is exact rather than a
 * hint. It is here because without it a client cannot tell a replay that has
 * finished from one that has not started -- both are a pane with nothing on
 * it -- and the case that matters most needs no counting at all: zero says
 * outright that this session has produced nothing.
 *
 * `droppedBytes` is how much the terminal printed before the replay begins,
 * over that terminal's whole life. Zero with a replay means the client is
 * being shown the session from its first byte; anything else means it is
 * joining mid-stream and can say by how much.
 *
 * Together they separate the two facts that render identically and mean
 * opposite things: a pane that silently starts mid-stream, and a pane showing
 * a session that has done nothing.
 *
 * There is no `truncated` flag beside them. `droppedBytes > 0` is that flag,
 * and a boolean carried next to the number it is derived from is a second
 * thing to keep in step across a relay for no gain -- the day they drifted,
 * the symptom would be a pane confidently mislabelling its own history.
 */
export const sessionSubscribedFrameSchema = z.object({
  type: z.literal('session-subscribed'),
  replyTo: frameIdSchema,
  storeId: storeIdSchema,
  sessionId: sessionIdSchema.nullable(),
  startId: frameIdSchema.nullable(),
  /** How many `terminal-output` frames of history follow, before live output. */
  replayChunks: z.int().nonnegative(),
  /** Bytes printed before the replay begins. `> 0` means this is a tail. */
  droppedBytes: z.int().nonnegative(),
});

/** The subscription is gone. The session is not: detaching closes nothing. */
export const sessionUnsubscribedFrameSchema = z.object({
  type: z.literal('session-unsubscribed'),
  replyTo: frameIdSchema,
});

/**
 * Output from a session, addressed by what the session is rather than by who
 * asked for it.
 *
 * Unsolicited, so no `replyTo`: it is a stream and nobody asked for any
 * particular chunk of it. It carries the session and the start handle for the
 * same reason the subscribe reply does -- a subscriber may have named either --
 * and carrying both is what lets one copy of a chunk answer every subscriber
 * watching that terminal instead of one copy per subscription.
 *
 * The scrollback a subscription replays travels on this frame too. One frame
 * shape for bytes, whether they are history or live, so that the thing reading
 * them has one path; the reply that precedes the replay is what says how much
 * of the beginning is missing and how many of these frames are history.
 */
export const terminalOutputFrameSchema = z.object({
  type: z.literal('terminal-output'),
  storeId: storeIdSchema,
  sessionId: sessionIdSchema.nullable(),
  startId: frameIdSchema.nullable(),
  chunk: terminalChunkSchema,
  /**
   * Chunks this stream threw away before this one, counted since it attached
   * and only ever increasing.
   *
   * It is zero today: nothing drops output yet. It is on the frame anyway,
   * because the answer AGX-209 is going to need for a session producing faster
   * than the hub consumes is to drop whole chunks and say so -- the same shape
   * `scrollback.ts` already uses for the same reason -- and adding the field
   * then would be a protocol version bump for a number. Adding it now costs a
   * zero on the wire.
   *
   * Cumulative rather than per frame so a reader that compares it with the
   * last value it saw learns the size of the gap, and one that does not
   * compare still sees a number that says the stream is lossy.
   */
  droppedChunks: z.int().nonnegative(),
});

/** How many bytes are turned into characters at once. Kept off the call stack. */
const ENCODE_BLOCK_BYTES = 8_192;

/**
 * Bytes to the characters a frame carries.
 *
 * Here, beside the schema that validates the result, so that the two ends of a
 * relay cannot disagree about what the field means. It re-encodes and never
 * decodes: every byte survives, including the ones that are not text.
 */
export function encodeTerminalChunk(bytes: Uint8Array): string {
  let latin1 = '';
  // In blocks, because spreading a megabyte of bytes into one call is how
  // `String.fromCharCode` overflows the call stack on a busy session.
  for (let at = 0; at < bytes.length; at += ENCODE_BLOCK_BYTES) {
    latin1 += String.fromCharCode(...bytes.subarray(at, at + ENCODE_BLOCK_BYTES));
  }
  return btoa(latin1);
}

/** The characters back to bytes. The reader's half of the pair above. */
export function decodeTerminalChunk(chunk: string): Uint8Array {
  const latin1 = atob(chunk);
  const bytes = new Uint8Array(latin1.length);
  for (let at = 0; at < latin1.length; at += 1) bytes[at] = latin1.charCodeAt(at);
  return bytes;
}
