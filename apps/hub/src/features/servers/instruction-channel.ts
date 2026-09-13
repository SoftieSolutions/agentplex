import type { FrameId, HubToServerFrame } from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';
import type { InstructionOutcome, SessionInstruction } from './servers.js';

/**
 * The instructions one connection is waiting on answers to.
 *
 * Keyed by the frame id each was sent with, which is what a reply names. A
 * connection that ends settles every one of them as a refusal: an instruction
 * whose answer can no longer arrive is not a promise to leave pending, and the
 * client waiting on it is owed a sentence.
 */

/**
 * How long an instruction may go unanswered.
 *
 * Longer than the handshake deadline, because a start is not a round trip on a
 * socket: the server scans a store and forks a process behind it. Short enough
 * that a client is not left with a spinner nothing will ever resolve -- a
 * deadline missed here is reported as a refusal the user can act on, and the
 * heartbeat is what decides whether the machine itself is still there.
 */
export const DEFAULT_INSTRUCTION_TIMEOUT_MS = 30_000;

export interface InstructionChannelDependencies {
  readonly timers: Timers;
  readonly logger: Logger;
  /**
   * The connection's frame id counter, continued: a frame id is unique within
   * one connection and the handshake already spent the first one.
   */
  readonly nextFrameId: () => number;
  readonly instructionTimeoutMs?: number;
  /** The one place an instruction becomes characters. */
  readonly send: (frame: HubToServerFrame) => void;
}

export interface InstructionChannel {
  ask(instruction: SessionInstruction): Promise<InstructionOutcome>;
  /**
   * Settles the instruction a reply names, and says whether anything was
   * waiting.
   *
   * The answer is read at one call site. A `session-refused` may be answering
   * an instruction or a terminal frame, and the transport tries this channel
   * first; `false` is what sends it on to the other one rather than dropping
   * a refusal a client is owed.
   */
  answer(replyTo: FrameId, outcome: InstructionOutcome): boolean;
  /** Settles everything still waiting, because nothing can answer it any more. */
  settleAll(problem: string): void;
}

export function createInstructionChannel(
  dependencies: InstructionChannelDependencies,
): InstructionChannel {
  const { timers, logger, nextFrameId, send } = dependencies;
  const instructionTimeoutMs = dependencies.instructionTimeoutMs ?? DEFAULT_INSTRUCTION_TIMEOUT_MS;

  const outstanding = new Map<FrameId, (outcome: InstructionOutcome) => void>();

  return {
    ask(instruction: SessionInstruction): Promise<InstructionOutcome> {
      return new Promise<InstructionOutcome>((resolve) => {
        const id = nextFrameId();
        let cancelDeadline: () => void = () => {};

        const settle = (outcome: InstructionOutcome): void => {
          cancelDeadline();
          resolve(outcome);
        };

        outstanding.set(id, settle);
        cancelDeadline = timers.schedule(instructionTimeoutMs, () => {
          if (!outstanding.delete(id)) return;
          // The connection is left alone. A server that is slow to answer one
          // instruction is not a server that has gone away, and that judgement
          // belongs to the heartbeat, which is asking its own question on the
          // same socket and closes when it goes unanswered.
          logger.warn('the server did not answer an instruction', {
            instruction: instruction.type,
            afterMs: instructionTimeoutMs,
          });
          resolve({
            ok: false,
            code: 'internal',
            problem: `the server did not answer within ${instructionTimeoutMs}ms`,
            hold: null,
          });
        });

        send({ ...instruction, id });
      });
    },

    answer(replyTo: FrameId, outcome: InstructionOutcome): boolean {
      const settle = outstanding.get(replyTo);
      outstanding.delete(replyTo);
      settle?.(outcome);
      return settle !== undefined;
    },

    settleAll(problem: string): void {
      const waiting = [...outstanding.values()];
      outstanding.clear();
      for (const settle of waiting) settle({ ok: false, code: 'internal', problem, hold: null });
    },
  };
}
