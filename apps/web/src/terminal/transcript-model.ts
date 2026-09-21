import { TRANSCRIPT_ACTIVITIES_MAX, type Activity, type FrameId } from '@agentplex/protocol';
import type { RefusalView, TranscriptView } from '../store/hub-store.js';

/**
 * What the Transcript tab has to show, as a pure function of what the store
 * holds and what this pane asked for.
 *
 * Pure and given everything, for the reason the rest of `presentation.ts` is:
 * the interesting cases are a pane waiting on a slow disk, a pane whose answer
 * was to somebody else's question, a session that has done nothing yet, and a
 * hub that said no -- and every one of them is a value a test can write down.
 * Nothing here renders and nothing here asks.
 *
 * The `replyTo` comparison is the whole of the correlation, and it is what
 * makes two panes on one session safe: the store keeps one answer, each pane
 * knows the id it asked with, and an answer to the other pane's question is
 * simply not this pane's answer. A pane that read the slot without checking
 * would draw one session's history under another session's name.
 */

/**
 * How many activities the tab asks for.
 *
 * The protocol's own ceiling, rather than a smaller number chosen here. It is
 * the most one frame will carry -- `activity.ts` holds the arithmetic -- so
 * asking for it means `olderExist` says something about the *file* rather than
 * about a bound this screen picked, and the sentence the tab shows is then a
 * fact about the session rather than about its own settings.
 */
export const TRANSCRIPT_COUNT = TRANSCRIPT_ACTIVITIES_MAX;

/**
 * What the tab draws, and what it says out loud.
 *
 * `status` is a sentence or `null`, never a code: every one of these is shown
 * to somebody who is looking at a session and wants to know why the list under
 * the tab is not what they expected. `tone` is semantic and is never a hue --
 * the two values are the two things a status can be here, and `tokens.ts` is
 * the one file that knows what either looks like.
 */
export interface TranscriptState {
  /** Oldest first, exactly as the machine holding the file answered. */
  readonly activities: readonly Activity[];
  readonly status: string | null;
  readonly tone: 'muted' | 'blocked';
}

const WAITING = 'Reading this session’s transcript…';
const NOTHING = 'This session’s transcript holds nothing this view can show yet.';
const UNASKED = 'This session’s transcript has not been read yet.';

/** The sentence for an answer that was cut short by the count. */
function olderThan(shown: number): string {
  return `Showing the last ${String(shown)}. This session did more before them, and the rest stays on the machine that holds the transcript.`;
}

export function transcriptState(
  askedWith: FrameId | null,
  answer: TranscriptView | null,
  refusal: RefusalView | null,
): TranscriptState {
  // Nothing has been asked. Reachable only before the tab has ever been
  // shown, and it says so rather than claiming the session did nothing -- the
  // difference between "we have not looked" and "there is nothing there" is
  // the whole of what this screen must not get wrong.
  if (askedWith === null) return { activities: [], status: UNASKED, tone: 'muted' };

  // The hub's own words, and only when they answer this pane's question. A
  // refusal to another pane's read, or to a stop somebody pressed, is not this
  // tab's business: the store keeps the newest "no" on the connection, and
  // drawing it here would put an unrelated sentence under a transcript.
  if (refusal !== null && refusal.replyTo === askedWith) {
    return { activities: [], status: refusal.message, tone: 'blocked' };
  }

  // Asked, and nothing back yet -- or something back that answers an earlier
  // ask. Both are "still reading" to a person looking at the tab, and both are
  // states a refresh resolves.
  if (answer === null || answer.replyTo !== askedWith) {
    return { activities: [], status: WAITING, tone: 'muted' };
  }

  if (answer.activities.length === 0) {
    // Not an error and not a blank panel. A session that has only been talked
    // to, or one whose provider records nothing this vocabulary can carry,
    // reaches here, and the honest thing is a sentence rather than emptiness
    // that reads as a screen that failed to load.
    return { activities: [], status: NOTHING, tone: 'muted' };
  }

  return {
    activities: answer.activities,
    status: answer.olderExist ? olderThan(answer.activities.length) : null,
    tone: 'muted',
  };
}
