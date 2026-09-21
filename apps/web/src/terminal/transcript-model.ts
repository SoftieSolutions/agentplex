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
 * The lookup by frame id is the whole of the correlation, and it is what makes
 * two panes on one session safe: the store files every answer under the id of
 * the frame that asked for it, each pane knows the ids it asked with, and the
 * other pane's answer is simply an entry this one never reads. A pane that read
 * "the newest answer" instead would draw one session's history under another
 * session's name -- and, worse, would go back to saying it was reading the
 * moment the other pane was answered, with no read of its own outstanding.
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
 * The reads this pane has out, as the pane remembers them.
 *
 * Two ids and not a list, because two is all a pane can use: the read it is
 * waiting on, and the newest earlier read it has an answer to, which is the
 * list it goes on drawing until the new one lands. The pane decides which
 * earlier id that is at the moment it asks again -- see `SessionPane` -- so
 * nothing here has to search a history and nothing accumulates.
 */
export interface TranscriptAsks {
  /** The frame the most recent read went out under. */
  readonly latest: FrameId;
  /**
   * The newest earlier read this pane had an answer to when it asked again, or
   * `null` when it had none.
   */
  readonly answered: FrameId | null;
}

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
/**
 * The answer that was cut short and still came back empty.
 *
 * Reachable, and not a contradiction: the machine reads the tail of the file by
 * bytes, and a window holding no complete activity -- one line longer than the
 * tail is enough -- is an empty list with the older-exist flag on it. Saying
 * "nothing to show" there would be a claim about the session. This is a claim
 * about the view, which is what is actually true.
 */
const UNREADABLE =
  'Nothing in the end of this session’s transcript could be read into this view, and there is more of it on the machine that holds the file.';

/** The sentence for an answer that was cut short by the count. */
function olderThan(shown: number): string {
  return `Showing the last ${String(shown)}. This session did more before them, and the rest stays on the machine that holds the transcript.`;
}

export function transcriptState(
  asks: TranscriptAsks | null,
  answers: ReadonlyMap<FrameId, TranscriptView>,
  refusal: RefusalView | null,
): TranscriptState {
  // Nothing has been asked. Reachable only before the tab has ever been
  // shown, and it says so rather than claiming the session did nothing -- the
  // difference between "we have not looked" and "there is nothing there" is
  // the whole of what this screen must not get wrong.
  if (asks === null) return { activities: [], status: UNASKED, tone: 'muted' };

  const fresh = answers.get(asks.latest) ?? null;
  // What stays on screen while the newest read is unanswered: the last list
  // this pane was given. Keeping it loses nothing and claims nothing -- the
  // sentence beside it says a read is out -- where blanking it throws away
  // something true because something truer is on its way.
  const kept = fresh ?? (asks.answered === null ? null : (answers.get(asks.answered) ?? null));
  const standing = kept?.activities ?? [];

  // The hub's own words, and only when they answer this pane's newest question.
  // A refusal to another pane's read, or to a stop somebody pressed, is not
  // this tab's business: the store keeps the newest "no" on the connection, and
  // drawing it here would put an unrelated sentence under a transcript.
  if (refusal !== null && refusal.replyTo === asks.latest) {
    return { activities: standing, status: refusal.message, tone: 'blocked' };
  }

  // Asked, and nothing back yet. The list under it is whatever this pane was
  // last given, which on a first read is nothing at all.
  if (fresh === null) return { activities: standing, status: WAITING, tone: 'muted' };

  if (fresh.activities.length === 0) {
    // Not an error and not a blank panel. A session that has only been talked
    // to, or one whose provider records nothing this vocabulary can carry,
    // reaches here, and the honest thing is a sentence rather than emptiness
    // that reads as a screen that failed to load. An empty answer that was
    // *also* cut short is the other sentence: there is more, and none of it
    // fitted the window this view read.
    return {
      activities: [],
      status: fresh.olderExist ? UNREADABLE : NOTHING,
      tone: 'muted',
    };
  }

  return {
    activities: fresh.activities,
    status: fresh.olderExist ? olderThan(fresh.activities.length) : null,
    tone: 'muted',
  };
}
