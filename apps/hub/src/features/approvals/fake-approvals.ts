import type { PendingApproval, ServerRegistrationId, SessionRef } from '@agentplex/protocol';
import type {
  ApprovalAnswer,
  ApprovalRequestedFrame,
  ApprovalSettledFrame,
  ApprovalWithdrawnFrame,
  Approvals,
  DecideRequest,
} from './approvals.js';

/**
 * The open requests, driven by hand, for the tests whose subject is the socket.
 *
 * What a client connection has to get right is what it does with an answer and
 * *when* it says it -- the decide path deliberately does not resolve when the
 * frame goes out, because the hook it releases may run for ten minutes. So the
 * one thing this fake does that a stub would not is leave an answer open: a
 * test drives the reply itself, which is the only way to assert that nothing
 * was sent to the client before the machine said what happened.
 *
 * It keeps no endings and enforces nothing about deciding once. Those rules are
 * exercised where they live, against the real feature with the connection seam
 * injected; a fake that re-implemented them would be a second copy free to
 * agree with a connection the real one would refuse.
 */
export interface FakeApprovals extends Approvals {
  /** Every decision asked for, in order. */
  readonly decided: readonly DecideRequest[];
  /** Every ref this fake announced through `onChanged`, in order. */
  readonly announced: readonly SessionRef[];
  /**
   * Answers the decision still waiting, as the machine holding it would.
   *
   * Throws when nothing is waiting, because a test that expected one and had
   * none has already gone wrong and a silent no-op would hide it.
   */
  answer(answer: ApprovalAnswer): void;
}

export interface FakeApprovalsOptions {
  /**
   * What a decision is answered with straight away, or nothing to leave every
   * one of them open for `answer` to settle.
   */
  readonly answer?: ApprovalAnswer;
  readonly onChanged?: (ref: SessionRef, approvals: readonly PendingApproval[]) => void;
}

export function createFakeApprovals(options: FakeApprovalsOptions = {}): FakeApprovals {
  const open = new Map<string, PendingApproval[]>();
  const decided: DecideRequest[] = [];
  const announced: SessionRef[] = [];
  const waiting: ((answer: ApprovalAnswer) => void)[] = [];

  const keyOf = (ref: SessionRef): string => JSON.stringify([ref.storeId, ref.sessionId]);

  const announce = (ref: SessionRef): void => {
    announced.push(ref);
    options.onChanged?.(ref, open.get(keyOf(ref)) ?? []);
  };

  const drop = (ref: SessionRef, approvalId: PendingApproval['approvalId']): void => {
    const held = open.get(keyOf(ref));
    if (held === undefined) return;
    open.set(
      keyOf(ref),
      held.filter((pending) => pending.approvalId !== approvalId),
    );
    announce(ref);
  };

  return {
    requested(_source: ServerRegistrationId, frame: ApprovalRequestedFrame): void {
      const ref: SessionRef = { storeId: frame.storeId, sessionId: frame.sessionId };
      const held = open.get(keyOf(ref)) ?? [];
      // A fixed stamp, because a fake that read a clock would be a second
      // opinion about the one number the real feature is the source of.
      held.push({ ...frame.approval, requestedAt: 0 });
      open.set(keyOf(ref), held);
      announce(ref);
    },

    withdrawn(_source: ServerRegistrationId, frame: ApprovalWithdrawnFrame): void {
      drop({ storeId: frame.storeId, sessionId: frame.sessionId }, frame.approvalId);
    },

    settled(_source: ServerRegistrationId, frame: ApprovalSettledFrame): void {
      drop({ storeId: frame.storeId, sessionId: frame.sessionId }, frame.approvalId);
    },

    serverGone(_registrationId: ServerRegistrationId): void {
      for (const [key, held] of [...open]) {
        if (held.length === 0) continue;
        open.set(key, []);
        const [storeId, sessionId] = JSON.parse(key) as [
          SessionRef['storeId'],
          SessionRef['sessionId'],
        ];
        announce({ storeId, sessionId });
      }
    },

    decide(request: DecideRequest): Promise<ApprovalAnswer> {
      decided.push(request);
      const answer = options.answer;
      if (answer !== undefined) return Promise.resolve(answer);
      return new Promise<ApprovalAnswer>((resolve) => waiting.push(resolve));
    },

    answer(answer: ApprovalAnswer): void {
      const resolve = waiting.shift();
      if (resolve === undefined) throw new Error('no decision is waiting to be answered');
      resolve(answer);
    },

    get decided(): readonly DecideRequest[] {
      return decided;
    },

    get announced(): readonly SessionRef[] {
      return announced;
    },
  };
}
