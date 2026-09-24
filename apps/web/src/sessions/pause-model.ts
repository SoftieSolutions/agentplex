import type { FrameId, SessionHolder, SessionRef } from '@agentplex/protocol';
import type { HubCommand, PausedView, RefusalView, ResumedView } from '../store/hub-store.js';

/**
 * Everything pausing and resuming a session decides, as pure functions:
 * whether either affordance exists, what the frames carry, what to make of the
 * hub's answer, and the one sentence shown while a pause waits for its turn
 * boundary.
 *
 * The components own nothing but the id of the command they are waiting on.
 * The tone and the word a paused session is drawn in live beside the status
 * rules in `session-list-model.ts` (`toneForSession`, `wordsForSession`),
 * because the list derives its rows there and this file imports from the
 * store, which the list must not depend on through here.
 */

/**
 * Whether a pause is offered: a holder, and no pause on it yet.
 *
 * Unlike a stop, `stoppable` is not consulted. A stop is withheld mid-turn
 * because it kills the process; a pause kills nothing and is exactly what a
 * person wants mid-turn -- "finish this and then wait for me". The server
 * records it and takes it at the boundary.
 */
export function offersPause(holder: SessionHolder | null): boolean {
  return holder !== null && holder.pause === 'none';
}

/**
 * Whether a resume is offered: a holder under any pause, requested or taken.
 * Resuming a request cancels it, which is the one way to take a pause back
 * before the boundary arrives.
 */
export function offersResume(holder: SessionHolder | null): boolean {
  return holder !== null && holder.pause !== 'none';
}

/** The pause command, exactly the fields the frame defines: a session, and nothing else. */
export function pauseCommand(ref: SessionRef): HubCommand {
  return { type: 'session-pause', storeId: ref.storeId, sessionId: ref.sessionId };
}

export function resumeCommand(ref: SessionRef): HubCommand {
  return { type: 'session-resume', storeId: ref.storeId, sessionId: ref.sessionId };
}

/** The sentence beside a session whose pause is recorded and not yet taken. */
export const PAUSE_REQUESTED_WORDS = 'Pausing at the next turn boundary';

/**
 * What to say beside the button about a pause that is still on its way, or
 * nothing. Only `requested` has anything to say: `paused` is said by the tone
 * and the word on the header, and `none` is the ordinary state of things.
 */
export function pauseNote(holder: SessionHolder | null): string | null {
  return holder?.pause === 'requested' ? PAUSE_REQUESTED_WORDS : null;
}

/**
 * Where a pause or a resume the user asked for has got to.
 *
 * `paused`, `resumed` and `refused` are all answers and all end the wait;
 * `waiting` is what disables the button. A refusal leaves the session exactly
 * as it was -- paused if it was paused -- and its words are shown beside the
 * button, in the blocked tone, rather than in place of anything.
 */
export type PauseFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'paused'; readonly pause: PausedView['pause'] }
  | { readonly kind: 'resumed' }
  | { readonly kind: 'refused'; readonly words: string };

/**
 * What the hub has said about the command this control is waiting on.
 *
 * Correlated by `replyTo` and never by "the most recent answer": the snapshot
 * holds one of each for the whole page, and a card that read the newest would
 * show another card's answer beside its own button.
 */
export function pauseFollowUp(
  pending: FrameId | null,
  lastPaused: PausedView | null,
  lastResumed: ResumedView | null,
  lastRefusal: RefusalView | null,
): PauseFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastPaused !== null && lastPaused.replyTo === pending) {
    return { kind: 'paused', pause: lastPaused.pause };
  }
  if (lastResumed !== null && lastResumed.replyTo === pending) return { kind: 'resumed' };
  return { kind: 'waiting' };
}

/**
 * The one word on the button.
 *
 * Read off the holder and not off the follow-up, except while waiting: the
 * holder is what every client sees, and a button that said "Resume" because
 * its own pause was answered, on a session whose holder had since been resumed
 * from another tab, would be offering to undo something already undone.
 */
export function pauseButtonWords(holder: SessionHolder | null, followUp: PauseFollowUp): string {
  if (offersResume(holder)) return followUp.kind === 'waiting' ? 'Resuming' : 'Resume';
  return followUp.kind === 'waiting' ? 'Pausing' : 'Pause';
}
