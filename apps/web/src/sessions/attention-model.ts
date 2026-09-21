import type { FrameId } from '@agentplex/protocol';
import type { HubCommand, RefusalView, AttentionView } from '../store/hub-store.js';
import { unseenPrompt, type SessionListItem } from './session-list-model.js';

/**
 * Everything acknowledging and muting decides, as pure functions: what each
 * frame carries, what the controls say, and what to make of the hub's answer.
 *
 * The components own nothing but the id of the frame they are waiting on. The
 * facts themselves are never held here: they arrive on the session row of the
 * machine state, which every tab is sent, so a mute made in one tab is drawn
 * in the other without either of them remembering it.
 */

/**
 * The acknowledgement command: the session and nothing else.
 *
 * No moment, deliberately. The hub stamps it, because the stamp exists to be
 * compared against a moment a provider wrote on a third machine, and a browser
 * clock in that comparison would make the answer depend on whose watch is fast.
 */
export function acknowledgeCommand(item: SessionListItem): HubCommand {
  return {
    type: 'session-acknowledge',
    storeId: item.ref.storeId,
    sessionId: item.ref.sessionId,
  };
}

/**
 * The mute command, carrying the state wanted rather than a toggle.
 *
 * A toggle would be a decision made against whatever this tab last drew, and
 * two tabs (or one tab and a reconnection) can draw different things. Saying
 * which state is wanted makes a second click on an already-muted row a no-op
 * instead of an unmute nobody asked for.
 */
export function muteCommand(item: SessionListItem, muted: boolean): HubCommand {
  return {
    type: 'session-mute',
    storeId: item.ref.storeId,
    sessionId: item.ref.sessionId,
    muted,
  };
}

/**
 * Whether the acknowledge control is offered at all.
 *
 * Only where there is something to acknowledge: a session that wants a human
 * and has not been seen since it last spoke. A button on a working session
 * would acknowledge a prompt that does not exist, and one on an already
 * acknowledged session would restamp a moment to no effect.
 *
 * That is `unseenPrompt` and not a second spelling of it: the button exists
 * for exactly the session the card and the row draw the accent on, and two
 * copies of the rule would let the control appear where the accent does not.
 */
export function offersAcknowledge(item: SessionListItem): boolean {
  return unseenPrompt(item);
}

/**
 * Where a frame the user sent has got to.
 *
 * The same three-state shape a stop has, and for the same reason: an answer
 * that never comes must leave the control disabled rather than inviting a
 * second click, and a refusal is words a person reads rather than a silence.
 */
export type AttentionFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly words: string };

/**
 * What the hub has said about the frame this control is waiting on.
 *
 * Correlated by `replyTo` and never by "the most recent answer": one snapshot
 * holds one refusal and one attention reply for the whole page, and a card
 * that read the newest of either would show another card's answer beside its
 * own button.
 */
export function attentionFollowUp(
  pending: FrameId | null,
  lastAttention: AttentionView | null,
  lastRefusal: RefusalView | null,
): AttentionFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastAttention !== null && lastAttention.replyTo === pending) return { kind: 'done' };
  return { kind: 'waiting' };
}
