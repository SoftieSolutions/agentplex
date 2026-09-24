import type { Activity } from '@agentplex/protocol';
import type { TranscriptState } from './transcript-model.js';

/**
 * Replay: walking back through what a session did, as a pure function of the
 * list the Transcript tab already holds and a position somebody asked for.
 *
 * It fetches nothing and knows no frame. The list is whatever AGX-82 read --
 * the activities a hub answered the pane's own `session-transcript` with --
 * and replay is a window onto the front of it. That is what keeps this file
 * free of the store, the socket and the tab: the pane hands it a list and a
 * number, and it hands back a shorter list and a sentence.
 *
 * A position is a request, not a fact about the list. It is held in the pane
 * as the number that was last asked for, and every reading of it goes through
 * `clampPosition` against the count as it stands *now*, because the count can
 * change under it: a refresh can answer with fewer activities than the step
 * somebody is standing on. Clamping at the moment of reading, rather than
 * correcting the state when the answer lands, is what makes this work without
 * an effect -- the pane holds a request and the render resolves it.
 */

/**
 * The position that means "the last step, whatever the count turns out to be".
 *
 * The Replay button presses it before the transcript has necessarily been
 * read: the press is what issues the read, so at that moment there may be no
 * count to take one off. A request that clamps to the end of any list is the
 * one value that does the right thing both then and once the answer lands.
 */
export const LAST_STEP = Number.MAX_SAFE_INTEGER;

/**
 * What the feed draws in replay, and what the bar says about it.
 *
 * `position` is the resolved one -- clamped, and `null` when there is nothing
 * to stand on -- so a bar drawn off this value never has to clamp again.
 */
export interface ReplayState {
  /** The activities up to and including the position; the whole list when live. */
  readonly activities: readonly Activity[];
  /** Which step of how many, or `null` when live. */
  readonly status: string | null;
  readonly position: number | null;
}

/**
 * A position brought inside `[0, count - 1]`, or `null` when it cannot be.
 *
 * `null` in means live and stays live. A count of zero has no range to clamp
 * into, and the answer is live rather than a step that does not exist: the
 * one thing replay must not do is stand on a step of an empty list and say
 * so.
 */
export function clampPosition(position: number | null, count: number): number | null {
  if (position === null || count <= 0) return null;
  return Math.min(Math.max(Math.trunc(position), 0), count - 1);
}

export function stepBack(position: number, count: number): number | null {
  const here = clampPosition(position, count);
  return here === null ? null : clampPosition(here - 1, count);
}

export function stepForward(position: number, count: number): number | null {
  const here = clampPosition(position, count);
  return here === null ? null : clampPosition(here + 1, count);
}

export function first(count: number): number | null {
  return clampPosition(0, count);
}

export function last(count: number): number | null {
  return clampPosition(LAST_STEP, count);
}

/** The sentence the bar reads out, one-based because it is for a person. */
function stepOf(position: number, count: number): string {
  return `Replaying step ${String(position + 1)} of ${String(count)}`;
}

export function replayState(activities: readonly Activity[], position: number | null): ReplayState {
  const here = clampPosition(position, activities.length);
  if (here === null) return { activities, status: null, position: null };
  return {
    activities: activities.slice(0, here + 1),
    status: stepOf(here, activities.length),
    position: here,
  };
}

/**
 * Whether there is anything to replay: at least one activity in the list the
 * tab holds. False while the read is out, was refused or answered empty --
 * the sentence beside the feed already says which, and a scrubber over
 * nothing would be a second claim on top of it.
 */
export function replayOffered(state: TranscriptState): boolean {
  return state.activities.length > 0;
}
