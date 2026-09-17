import { z } from 'zod';
import { frameIdSchema } from './frames.js';
import { sessionIdSchema, startIdSchema, storeIdSchema } from './identity.js';

/**
 * Terminal frames: the bytes a session produces, the keystrokes it is given,
 * and the standing interest that connects the two.
 *
 * They live here rather than in `client.ts` or `server.ts` because they are the
 * one part of the protocol that is relayed rather than answered. A client
 * subscribes to a session, the hub subscribes to the server holding it, and the
 * chunk that comes back travels both legs almost unchanged; two hand-written
 * copies of these shapes would be two things to keep in step for no gain, and
 * the day they drifted the symptom would be a terminal that renders almost
 * right.
 *
 * Each direction still owns exactly one parser. `client.ts` and `server.ts`
 * put these schemas into their own unions, and nothing downstream re-checks a
 * `type` the union already decided.
 *
 * ## The one field that differs between the legs, and why it is not two files
 *
 * A terminal is addressed by the session it runs, or -- in the gap before the
 * provider has written a session id -- by the start that asked for it. That
 * start handle is the only thing on these frames that is not the same on both
 * legs, and it cannot be: a client's handle is its own `session-start` frame
 * id, which is the name it already has for what it asked and is meaningless
 * anywhere else, while the hub's handle for the same start is a `StartId` it
 * minted, which is the name that survives the hub redialling the server.
 * `identity.ts` carries that argument.
 *
 * So the shapes are written once and instantiated twice, `terminalFramesFor`
 * below taking the schema of the leg's start handle. The alternative -- a
 * second copy of seven frames differing in one field -- is exactly the drift
 * this file was written to avoid, and the one after that -- a union of the two
 * handle types on one schema -- would make every reader of a target decide
 * which leg it came off, which is a decision no reader has the information to
 * make.
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
 * trade taken deliberately. It is bounded by the same things the wire is
 * bounded by -- a chunk cap here, and a sender that drops whole chunks and
 * counts them when its peer stops keeping up -- and moving to a binary channel
 * later is a protocol version bump and two encoders, not a redesign.
 */

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
 * One leg's terminal frames, given the schema of the start handle that leg
 * names a not-yet-identified spawn by.
 *
 * Called twice, immediately below, and nowhere else: the two legs are the whole
 * of the world this parameter has, and keeping both calls here is what makes
 * "these are the same frames, and this is the one field that differs" something
 * a reader sees in one place rather than infers from two files.
 */
function terminalFramesFor<Handle extends z.ZodType>(startId: Handle) {
  /**
   * Which terminal a frame is about.
   *
   * A session's identity is `{ storeId, sessionId }`, and that is the ordinary
   * way to name one. The other way exists because of the gap at the start of a
   * spawn: the provider mints its own session id and writes it moments after
   * the process is up, so between the fork and the first scan there is a live
   * terminal producing output and no session id to address it by. The start
   * handle is the name that exists in that gap, which is what lets a pending
   * pane show a real terminal while the provider is still starting.
   *
   * A discriminated union rather than two optional fields, so that "either" is
   * something a parser decides and not something a reader guesses. An object
   * carrying both would otherwise be a frame whose meaning depends on which
   * field the receiver happens to check first.
   *
   * There is no terminal id here, and there is nowhere to put one. A terminal
   * id is the server's own bookkeeping for a process on its own machine, and a
   * peer that could name one could name any of them.
   */
  const target = z.discriminatedUnion('by', [
    z.object({
      by: z.literal('session'),
      storeId: storeIdSchema,
      sessionId: sessionIdSchema,
    }),
    z.object({
      by: z.literal('start'),
      /**
       * The handle of the `session-start` that asked for this session, in
       * whichever of the two forms this leg uses. Neither of them ever
       * identifies a session: a start handle is a handle on one act of
       * starting, and it stops being useful the moment the session has a name
       * of its own.
       */
      startId,
    }),
  ]);

  return {
    target,

    /**
     * Standing interest in one terminal's output.
     *
     * It is a frame rather than a side effect of opening something, and it has
     * a partner below, because the count it moves is the one eviction reads. A
     * subscribe with no unsubscribe would leave the server's "how many are
     * watching this" only ever growing, and the longest-unwatched rule would be
     * choosing between terminals that all claim to be watched.
     */
    subscribe: z.object({
      type: z.literal('session-subscribe'),
      id: frameIdSchema,
      target,
    }),

    /**
     * Stops watching a session without stopping it.
     *
     * The partner of `session-subscribe`, and the whole difference between
     * closing a tab and killing an agent. Detaching never closes a terminal:
     * sessions outlive tabs and sockets, a lid closing is not a decision, and
     * an agent mid-work goes on working with nobody watching.
     */
    unsubscribe: z.object({
      type: z.literal('session-unsubscribe'),
      id: frameIdSchema,
      target,
    }),

    /**
     * Keystrokes for a session.
     *
     * Answered only when it fails. Every other frame here gets a reply, and
     * this one does not, because a terminal already acknowledges input the way
     * terminals do -- it echoes it -- and an acknowledgement per keystroke
     * would double the frame rate of the busiest path on the wire to restate
     * what is already on the user's screen. A write that could not be delivered
     * is refused, naming this frame, which is the case a user cannot see for
     * themselves.
     */
    input: z.object({
      type: z.literal('terminal-input'),
      id: frameIdSchema,
      target,
      data: terminalInputSchema,
    }),

    /** The viewer's size, for the pty to be resized to. Refused only when it fails. */
    resize: z.object({
      type: z.literal('terminal-resize'),
      id: frameIdSchema,
      target,
      size: terminalSizeSchema,
    }),

    /**
     * The subscription is attached, and here is what it is attached to.
     *
     * It names both `sessionId` and `startId`, whichever the subscription used,
     * because the answer to "which terminal did I just attach to" is the pair:
     * a subscription made by start handle is answered with a `sessionId` of
     * `null` until the provider names the session, and one made by session is
     * answered with the start handle when the peer being answered is the one
     * that started it.
     *
     * ## What a subscriber is given on attach, and what it is told about it
     *
     * A subscription to a session that has been running an hour is answered
     * with a bounded tail of what it printed -- the scrollback the server
     * already keeps, replayed on `terminal-output` frames that follow this one.
     * Not everything, because a server holds a pty and not a recording; not
     * nothing, because a pane that opens blank on a busy agent is useless.
     *
     * A tail is not the session, so this frame carries the two numbers that
     * keep a pane from claiming it is.
     *
     * `replayChunks` is how many `terminal-output` frames of history follow
     * this one, after which the stream is live. The socket is ordered and the
     * replay is written in the same turn as this reply, so the count is exact
     * rather than a hint. It is here because without it a client cannot tell a
     * replay that has finished from one that has not started -- both are a pane
     * with nothing on it -- and the case that matters most needs no counting at
     * all: zero says outright that this session has produced nothing.
     *
     * `droppedBytes` is how much the terminal printed before the replay begins,
     * over that terminal's whole life. Zero with a replay means the subscriber
     * is being shown the session from its first byte; anything else means it is
     * joining mid-stream and can say by how much.
     *
     * Together they separate the two facts that render identically and mean
     * opposite things: a pane that silently starts mid-stream, and a pane
     * showing a session that has done nothing.
     *
     * There is no `truncated` flag beside them. `droppedBytes > 0` is that
     * flag, and a boolean carried next to the number it is derived from is a
     * second thing to keep in step across a relay for no gain -- the day they
     * drifted, the symptom would be a pane confidently mislabelling its own
     * history.
     */
    subscribed: z.object({
      type: z.literal('session-subscribed'),
      replyTo: frameIdSchema,
      storeId: storeIdSchema,
      sessionId: sessionIdSchema.nullable(),
      startId: startId.nullable(),
      /** How many `terminal-output` frames of history follow, before live output. */
      replayChunks: z.int().nonnegative(),
      /** Bytes printed before the replay begins. `> 0` means this is a tail. */
      droppedBytes: z.int().nonnegative(),
    }),

    /** The subscription is gone. The session is not: detaching closes nothing. */
    unsubscribed: z.object({
      type: z.literal('session-unsubscribed'),
      replyTo: frameIdSchema,
    }),

    /**
     * Output from a session, addressed by what the session is rather than by
     * who asked for it.
     *
     * Unsolicited, so no `replyTo`: it is a stream and nobody asked for any
     * particular chunk of it. It carries the session and the start handle for
     * the same reason the subscribe reply does -- a subscriber may have named
     * either -- and carrying both is what lets one copy of a chunk answer every
     * subscriber watching that terminal instead of one copy per subscription.
     *
     * The scrollback a subscription replays travels on this frame too. One
     * frame shape for bytes, whether they are history or live, so that the
     * thing reading them has one path; the reply that precedes the replay is
     * what says how much of the beginning is missing and how many of these
     * frames are history.
     */
    output: z.object({
      type: z.literal('terminal-output'),
      storeId: storeIdSchema,
      sessionId: sessionIdSchema.nullable(),
      startId: startId.nullable(),
      chunk: terminalChunkSchema,
      /**
       * Chunks this stream threw away before this one, over the life of the
       * stream on this connection, and only ever increasing.
       *
       * A session produces output at whatever rate its child prints, and a peer
       * reads at whatever rate its link allows. When the second is slower than
       * the first for long enough, something has to give, and what gives is the
       * bytes: the sender drops whole chunks rather than buffering them until
       * it dies, and this is how it admits to having done so. Whole chunks,
       * never part of one, because an escape sequence spans whatever boundary
       * it lands on -- the same rule, for the same reason, that `scrollback.ts`
       * trims by.
       *
       * Cumulative rather than per frame so a reader that compares it with the
       * last value it saw learns the size of the gap, and one that does not
       * compare still sees a number that says the stream is lossy.
       *
       * ## Why this is not `droppedBytes`, and not added to it
       *
       * `session-subscribed` carries `droppedBytes`, and the two are different
       * losses at different layers that happen to render the same way on a
       * screen. `droppedBytes` is history the terminal evicted before anyone
       * attached: a property of the session, the same for every peer watching
       * it, and fixed at the moment of attaching. This is output that existed
       * and did not fit down one link: a property of one connection, different
       * for two peers watching the same terminal, and growing while the stream
       * runs.
       *
       * Summed into one number they would tell a user the gap is in the
       * session's history when it is in their own connection -- and the sum
       * would be wrong for the other peer, which lost nothing. So: two numbers,
       * because a pane that says "the first 40 MB is gone" and a pane that says
       * "this link is dropping output" are asking for two different things to
       * be done about it.
       */
      droppedChunks: z.int().nonnegative(),
    }),
  };
}

/**
 * The client leg's terminal frames.
 *
 * A start handle here is the client's own `session-start` frame id: the name it
 * already has for what it asked, local to that socket, and gone when the socket
 * closes -- which is exactly as long as the pane waiting on it lasts.
 */
export const clientTerminalFrames = terminalFramesFor(frameIdSchema);

/**
 * The server leg's terminal frames.
 *
 * A start handle here is the `StartId` the hub minted, which is what lets a hub
 * that redialled still name a spawn whose provider has not named it yet.
 */
export const serverTerminalFrames = terminalFramesFor(startIdSchema);

export const clientTerminalTargetSchema = clientTerminalFrames.target;
export type ClientTerminalTarget = z.infer<typeof clientTerminalTargetSchema>;

export const serverTerminalTargetSchema = serverTerminalFrames.target;
export type ServerTerminalTarget = z.infer<typeof serverTerminalTargetSchema>;

/**
 * Why a subscription stopped feeding a pane.
 *
 * Three, because they are three different things to do about it. A machine
 * that dropped is one the hub is already dialling again, and the pane it was
 * feeding will be re-attached without anybody clicking anything. A machine
 * that said it was going down first is one to leave alone for a minute: the
 * hub waits the grace it named rather than hammering a box that is trying to
 * exit. And a terminal that is no longer there is the one case where waiting
 * changes nothing -- the process is gone, or the machine holding it was
 * restarted -- so the pane is showing the last of a session rather than a feed
 * that is about to resume.
 *
 * The first two are the connection's own words, taken off the reason the hub
 * recorded when it lost the machine; the third is what a server answered a
 * re-subscribe with on the redial, which is the only end that can say whether
 * a terminal survived.
 */
export const subscriptionEndReasonSchema = z.enum([
  'server-dropped',
  'server-draining',
  'session-ended',
]);
export type SubscriptionEndReason = z.infer<typeof subscriptionEndReasonSchema>;

/**
 * A subscription this client holds has stopped, and why.
 *
 * The one terminal frame that is not relayed, which is why it is written here
 * once rather than instantiated for both legs. Every other frame in this file
 * travels two hops almost unchanged, because a chunk a server produced is a
 * chunk a browser paints. This one is the hub's own sentence about its own
 * bookkeeping: the hub holds one upstream subscription per terminal on behalf
 * of whoever is watching, and when the machine holding that terminal goes
 * away there is nothing on the other leg to relay -- the server did not say
 * this, it stopped saying anything.
 *
 * Unsolicited, so no `replyTo`. The alternative was `session-unsubscribed`,
 * which is a reply and needs the id of the frame that asked; nobody asked for
 * this, and a reply to a frame that was already answered would be the hub
 * answering a question twice with two different meanings.
 *
 * Addressed by `target` rather than by the `storeId`/`sessionId`/`startId`
 * that `terminal-output` carries, and the difference is who a frame is for. A
 * chunk is addressed by what the session *is*, so that one copy of it answers
 * every subscriber however each of them named it. This is addressed to one
 * subscription, under the name that subscription used -- which is the name the
 * pane waiting on it is keyed by, and the only one that reaches a pane still
 * watching a start the provider has not named yet.
 *
 * It does not mean the watch is over. A client that still wants the terminal
 * keeps its standing interest and its buffered bytes: the hub re-subscribes
 * for it when the machine answers again, and the fresh `session-subscribed`
 * that follows is what says how much history is being replayed into a pane
 * that has a gap in it. The exception is `session-ended`, where there is
 * nothing left to re-attach to and the hub has given the subscription back.
 */
export const subscriptionEndedFrameSchema = z.object({
  type: z.literal('session-subscription-ended'),
  target: clientTerminalFrames.target,
  reason: subscriptionEndReasonSchema,
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
