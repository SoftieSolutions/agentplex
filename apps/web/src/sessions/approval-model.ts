import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalOutcome,
  FrameId,
  SessionRef,
} from '@agentplex/protocol';
import type { ApprovalView, HubCommand, RefusalView } from '../store/hub-store.js';

/**
 * Everything answering an approval decides, as pure functions: what the frame
 * carries, and what to make of the hub's word about it.
 *
 * Shaped after `attention-model.ts` deliberately, because the two controls have
 * the same problem: a component owns the id of the frame it is waiting on and
 * nothing else, and the facts themselves arrive on the session row of the
 * machine state, which every tab is sent. So an approval answered in one tab
 * leaves the other tab's card without either of them remembering it, and a
 * client that reconnects mid-request sees exactly what is still open.
 *
 * The one difference from attention is the answer. An acknowledgement either
 * landed or did not; an approval has four endings, only two of which are the
 * answer taking effect, so `done` is not a word this can use.
 */

/**
 * The decision command: the session, the request, and one of two words.
 *
 * The approval is named beside the session because a session can hold more
 * than one open at a time, and because the id is what deciding once keys on:
 * two clients tapping at the same moment send the same id, and the second is
 * told what the first one's answer did.
 *
 * Nothing of the proposal goes back. The text a card rendered is the hub's to
 * remember, and a frame returning it would be a client choosing what the agent
 * is about to run -- the rule about operation names and argv elements defeated
 * by the one path built to carry a command as text.
 */
export function decideCommand(
  ref: SessionRef,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
): HubCommand {
  return {
    type: 'approval-decide',
    storeId: ref.storeId,
    sessionId: ref.sessionId,
    approvalId,
    decision,
  };
}

/**
 * Where a decision the user sent has got to.
 *
 * `decided` carries the hub's word rather than a boolean, because the four
 * endings read differently to the person who tapped: two of them are the
 * answer taking effect (possibly somebody else's), and `withdrawn` and
 * `expired` are the ones where an answer was given and nothing came of it.
 * Flattening them would turn "the hook had already stopped waiting" into a
 * denial the person would believe they had made.
 */
export type ApprovalFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'decided'; readonly outcome: ApprovalOutcome }
  | { readonly kind: 'refused'; readonly words: string };

/**
 * What the hub has said about the frame this control is waiting on.
 *
 * Correlated by `replyTo` and never by "the most recent answer", exactly as
 * `attentionFollowUp` is: one snapshot holds one refusal and one approval
 * reply for the whole page, and two cards can each be waiting -- a card that
 * read the newest of either would draw the other one's outcome under its own
 * buttons.
 */
export function approvalFollowUp(
  pending: FrameId | null,
  lastApproval: ApprovalView | null,
  lastRefusal: RefusalView | null,
): ApprovalFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastApproval !== null && lastApproval.replyTo === pending) {
    return { kind: 'decided', outcome: lastApproval.outcome };
  }
  return { kind: 'waiting' };
}
