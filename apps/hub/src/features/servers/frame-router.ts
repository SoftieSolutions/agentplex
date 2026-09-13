import { assertNever, type FrameId, type ServerToHubFrame } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { InstructionOutcome, StreamAnswer, TerminalOutputFrame } from './servers.js';

/**
 * Routes what a server says on an established connection.
 *
 * One parser for the direction, and the discriminated union it returns is
 * switched on rather than re-checked: an answer goes to whoever asked, a
 * report goes to the reducer, a terminal frame goes to the relay, and the
 * handshake frames belong to a handshake that is already over. `pong` is the
 * heartbeat's, which reads the socket itself.
 *
 * The switch is exhaustive, and that is the reason this is a file rather than
 * a closure. Before it was, the four frames of the terminal relay parsed
 * cleanly and fell out of the bottom, and nothing -- not a log line, not a type
 * error -- said so. Now a frame this build does not handle is a debug line that
 * names it, and a frame added to the protocol with no case here fails
 * typecheck.
 *
 * Three of those four have somewhere to go now, and which kind of thing a
 * terminal frame is gets decided here rather than one layer up: a reply to a
 * subscribe and a chunk nobody asked for arrive on one socket and are settled
 * by entirely different machinery, and a transport that took them as one union
 * would be re-checking a `type` this switch has already read.
 */

/** A server's whole view of one store, as the frame carries it. */
export type StoreReport = Extract<ServerToHubFrame, { type: 'store-report' }>;

export interface ServerFrameHandlers {
  /** The reply to an instruction, addressed by the frame id it answers. */
  onAnswer(replyTo: FrameId, outcome: InstructionOutcome): void;
  /** A store report, unsolicited and whole. */
  onReport(report: StoreReport): void;
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

export function routeServerFrame(
  frame: ServerToHubFrame,
  handlers: ServerFrameHandlers,
  logger: Logger,
): void {
  switch (frame.type) {
    case 'session-started':
    case 'session-stopped':
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
    case 'store-report':
      handlers.onReport(frame);
      return;
    case 'session-subscribed':
    case 'session-unsubscribed':
      handlers.onStreamAnswer(frame.replyTo, frame);
      return;
    case 'terminal-output':
      handlers.onOutput(frame);
      return;
    case 'handshake-accepted':
    case 'handshake-rejected':
    case 'pong':
    case 'protocol-error':
      return;
    case 'server-draining':
      // Parsed, and dropped on purpose. The drain is AGX-83's stack; until it
      // lands, a server that sends this is ahead of this hub, and the line
      // below is the only evidence there will be.
      logger.debug('frame dropped: this hub build does not handle it yet', { type: frame.type });
      return;
    default:
      return assertNever(frame, 'server frame');
  }
}
