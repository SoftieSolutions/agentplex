import { assertNever, type FrameId, type ServerToHubFrame } from '@agentplex/protocol';
import type { InstructionOutcome, StreamAnswer, TerminalOutputFrame } from './servers.js';

/**
 * Routes what a server says on an established connection.
 *
 * One parser for the direction, and the discriminated union it returns is
 * switched on rather than re-checked: an answer goes to whoever asked, a
 * report goes to the reducer, a drain notice goes to the loop that decides
 * when to dial, a terminal frame goes to the relay, and the handshake frames
 * belong to a handshake that is already over. `pong` is the heartbeat's, which
 * reads the socket itself.
 *
 * A document reply is an answer like any other: the three of them address the
 * frame that asked, so they go to whoever asked and this file says nothing
 * about documents beyond that.
 *
 * The switch is exhaustive, and that is the reason this is a file rather than
 * a closure. Before it was, the four frames of the terminal relay parsed
 * cleanly and fell out of the bottom, and nothing -- not a log line, not a type
 * error -- said so. With the relay landed there is nothing left for this build
 * to drop, so the arm that named a dropped frame at debug is gone with it and
 * the exhaustiveness check is the whole of the guard: a frame added to the
 * protocol with no case here fails typecheck, which is a louder answer than a
 * line in a log nobody reads until something has already gone missing.
 *
 * Which kind of thing a terminal frame is gets decided here rather than one
 * layer up: a reply to a subscribe and a chunk nobody asked for arrive on one
 * socket and are settled by entirely different machinery, and a transport that
 * took them as one union would be re-checking a `type` this switch has already
 * read.
 */

/** A server's whole view of one store, as the frame carries it. */
export type StoreReport = Extract<ServerToHubFrame, { type: 'store-report' }>;

/** A server saying it is going down, and how long it will wait first. */
export type DrainingNotice = Extract<ServerToHubFrame, { type: 'server-draining' }>;

export interface ServerFrameHandlers {
  /** The reply to an instruction, addressed by the frame id it answers. */
  onAnswer(replyTo: FrameId, outcome: InstructionOutcome): void;
  /** A store report, unsolicited and whole. */
  onReport(report: StoreReport): void;
  /**
   * The drain notice, unsolicited and sent once.
   *
   * Routed rather than acted on here, because what it means is a decision two
   * layers up: the connection is still good, so nothing about this socket
   * changes, and what does change is what the hub says about the machine and
   * when it expects to dial it again.
   */
  onDraining(notice: DrainingNotice): void;
  /**
   * The reply to a subscribe or an unsubscribe, addressed by the frame it
   * answers.
   *
   * Apart from `onAnswer` because the two are waited on by different
   * machinery: an instruction is one round trip somebody awaits, and a
   * subscription is a standing thing whose reply is followed immediately by the
   * history it just promised. `session-refused` is the one frame that may be
   * the answer to either, and it goes to `onAnswer` -- the transport is where
   * the two are told apart, because it is the only thing that knows which of
   * its frame ids it spent on which.
   */
  onStreamAnswer(replyTo: FrameId, answer: StreamAnswer): void;
  /**
   * Output from a terminal on this server. Unsolicited, because it is a stream
   * and nobody asked for any particular chunk of it.
   */
  onOutput(output: TerminalOutputFrame): void;
}

export function routeServerFrame(frame: ServerToHubFrame, handlers: ServerFrameHandlers): void {
  switch (frame.type) {
    case 'session-started':
    case 'session-stopped':
    case 'directory-listing':
    case 'doc-written':
    case 'doc-content':
    case 'doc-listing':
      handlers.onAnswer(frame.replyTo, { ok: true, answer: frame });
      return;
    case 'session-refused':
      handlers.onAnswer(frame.replyTo, {
        ok: false,
        code: frame.code,
        problem: frame.message,
        hold: frame.hold,
      });
      return;
    case 'directory-refused':
      // The same outcome shape with no hold to put in it, which is why the
      // frame is its own: a directory has no live process to name, and a field
      // that was always null on half the refusals would be one every reader had
      // to learn when it means anything.
      handlers.onAnswer(frame.replyTo, {
        ok: false,
        code: frame.code,
        problem: frame.message,
        hold: null,
      });
      return;
    case 'store-report':
      handlers.onReport(frame);
      return;
    case 'server-draining':
      handlers.onDraining(frame);
      return;
    case 'session-subscribed':
    case 'session-unsubscribed':
      handlers.onStreamAnswer(frame.replyTo, frame);
      return;
    case 'terminal-output':
      handlers.onOutput(frame);
      return;
    case 'approval-requested':
    case 'approval-withdrawn':
    case 'approval-settled':
      // Parsed and not yet routed: the approvals feature that holds them is
      // AGX-127 step 4, and this arm is what lets the protocol carry them in
      // the meantime. Named rather than left to the `default`, which is the
      // whole point of the switch ending in `assertNever` -- a frame nobody
      // handles is a decision somebody wrote down, not a silence.
      return;
    case 'handshake-accepted':
    case 'handshake-rejected':
    case 'pong':
    case 'protocol-error':
      return;
    default:
      return assertNever(frame, 'server frame');
  }
}
