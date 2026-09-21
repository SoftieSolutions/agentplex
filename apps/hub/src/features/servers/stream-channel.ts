import type { FrameId, HubToServerFrame } from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';
import type { DecideInstruction, StreamInstruction, StreamOutcome } from './servers.js';

/**
 * The frames one connection is waiting on answers to that may never come.
 *
 * The instruction channel beside this one does the same job for a start and a
 * stop, and the two are separate for a reason that is not tidiness: an
 * instruction has exactly one reply and the caller awaits it, while two of the
 * four terminal frames here are answered only when they fail. A channel that
 * promised every caller an answer would have to invent one for a keystroke that
 * worked, and a channel that promised none could not carry a subscription's
 * reply.
 *
 * An approval decision is carried here for exactly that property rather than
 * because it is a terminal frame: a server that hands a decision to a blocked
 * hook says nothing, and only a refusal comes back. Putting it on the
 * instruction channel would give a ten-minute tool call a thirty-second
 * deadline; putting it anywhere that had to invent an answer would report a
 * refusal that never arrived.
 *
 * ## Why the answer is a callback and not a promise
 *
 * A subscription's reply is followed immediately, in the same turn, by the
 * scrollback it just promised: `session-subscribed` says how many
 * `terminal-output` frames of history come next, and the server writes them
 * with nothing awaited in between. A promise settles on a microtask, so a relay
 * built on one would send the client its history before the frame that counts
 * it -- and the count would be a lie about frames the client already had. A
 * callback runs where the frame was read, which keeps the relay in the order
 * the wire was in.
 */

/**
 * How long a frame may go unanswered before this stops listening.
 *
 * Shorter than an instruction's deadline, because none of these asks a server
 * to do anything slow: a subscribe reads a scrollback it is already holding, a
 * write hands bytes to a pty, and a decision is handed to a hook that is
 * already connected. The deadline is not a timeout a user waits out -- it is
 * how long a silent success stays distinguishable from a refusal that is still
 * in flight, after which the entry is dropped so that typing into a terminal
 * cannot accumulate correlations without bound.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 10_000;

export interface StreamChannelDependencies {
  readonly timers: Timers;
  readonly logger: Logger;
  /** The connection's frame id counter, continued. See `instruction-channel.ts`. */
  readonly nextFrameId: () => number;
  readonly streamTimeoutMs?: number;
  /** The one place such a frame becomes characters. */
  readonly send: (frame: HubToServerFrame) => void;
}

export interface StreamChannel {
  /** Puts one frame to the server and calls back with whatever answers it. */
  put(frame: StreamInstruction | DecideInstruction, answer: (outcome: StreamOutcome) => void): void;
  /**
   * Settles the frame a reply names, and says whether anything was waiting.
   *
   * The answer matters at exactly one call site: a `session-refused` may be
   * answering an instruction or one of these, and the transport tries the
   * instruction channel first. A reply nothing here is waiting for is a reply
   * for the other channel, or for a frame whose deadline has passed.
   */
  settle(replyTo: FrameId, outcome: StreamOutcome): boolean;
  /** Settles everything still waiting, because nothing can answer it any more. */
  settleAll(problem: string): void;
}

export function createStreamChannel(dependencies: StreamChannelDependencies): StreamChannel {
  const { timers, logger, nextFrameId, send } = dependencies;
  const streamTimeoutMs = dependencies.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const outstanding = new Map<FrameId, (outcome: StreamOutcome) => void>();

  const take = (replyTo: FrameId): ((outcome: StreamOutcome) => void) | undefined => {
    const settle = outstanding.get(replyTo);
    outstanding.delete(replyTo);
    return settle;
  };

  return {
    put(
      frame: StreamInstruction | DecideInstruction,
      answer: (outcome: StreamOutcome) => void,
    ): void {
      const id = nextFrameId();
      let cancelDeadline: () => void = () => {};

      outstanding.set(id, (outcome: StreamOutcome) => {
        cancelDeadline();
        answer(outcome);
      });

      cancelDeadline = timers.schedule(streamTimeoutMs, () => {
        const settle = take(id);
        if (settle === undefined) return;
        // Silence is the answer for an input, a resize and a decision, and the
        // absence of one for a subscribe. All are `ok` with nothing said,
        // because this cannot tell a server that had nothing to say from one
        // that is slow, and the connection's own heartbeat is what decides
        // whether the machine is still there.
        logger.debug('the server said nothing about a frame it answers only to refuse', {
          frame: frame.type,
          afterMs: streamTimeoutMs,
        });
        settle({ ok: true, answer: null });
      });

      send({ ...frame, id });
    },

    settle(replyTo: FrameId, outcome: StreamOutcome): boolean {
      const settle = take(replyTo);
      if (settle === undefined) return false;
      settle(outcome);
      return true;
    },

    settleAll(problem: string): void {
      const waiting = [...outstanding.values()];
      outstanding.clear();
      for (const settle of waiting) settle({ ok: false, code: 'internal', problem });
    },
  };
}
