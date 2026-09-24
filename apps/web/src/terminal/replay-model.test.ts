import { describe, expect, it } from 'vitest';
import type { Activity } from '@agentplex/protocol';
import {
  clampPosition,
  first,
  last,
  LAST_STEP,
  replayOffered,
  replayState,
  stepBack,
  stepForward,
} from './replay-model.js';
import type { TranscriptState } from './transcript-model.js';

/**
 * Replay as a value: a list the tab already holds, a position somebody asked
 * for, and what is drawn as a result. Nothing here fetches -- the list is
 * whatever AGX-82 read -- so every case is a position against a count.
 */

const STEPS: readonly Activity[] = [
  { kind: 'command', text: 'pnpm install', exitStatus: 0 },
  { kind: 'command', text: 'pnpm test', exitStatus: 1 },
  { kind: 'command', text: 'pnpm test', exitStatus: 0 },
  { kind: 'command', text: 'pnpm lint', exitStatus: 0 },
];

function transcript(activities: readonly Activity[]): TranscriptState {
  return { activities, status: null, tone: 'muted' };
}

describe('replayState', () => {
  it('shows everything, with nothing to say, while the position is live', () => {
    const state = replayState(STEPS, null);

    expect(state.activities).toBe(STEPS);
    expect(state.status).toBeNull();
    expect(state.position).toBeNull();
  });

  it('shows the activities up to the position and says which step that is', () => {
    const state = replayState(STEPS, 1);

    expect(state.activities).toEqual(STEPS.slice(0, 2));
    expect(state.status).toBe('Replaying step 2 of 4');
    expect(state.position).toBe(1);
  });

  it('shows the whole list at the last step, and says so', () => {
    const state = replayState(STEPS, 3);

    expect(state.activities).toEqual(STEPS);
    expect(state.status).toBe('Replaying step 4 of 4');
  });

  it('clamps a position past either end rather than drawing nothing', () => {
    // A fresh answer with fewer activities than the position, which a refresh
    // mid-replay produces: the honest reading is the last step there is, not
    // an empty feed under a sentence about a step that no longer exists.
    expect(replayState(STEPS, 9)).toMatchObject({
      activities: STEPS,
      status: 'Replaying step 4 of 4',
      position: 3,
    });
    expect(replayState(STEPS, -2)).toMatchObject({
      activities: STEPS.slice(0, 1),
      status: 'Replaying step 1 of 4',
      position: 0,
    });
  });

  it('answers live on an empty list, whatever the position asked for', () => {
    // There is no step to stand on, so the clamp has no range. Live, rather
    // than a sentence about step 1 of 0.
    const state = replayState([], LAST_STEP);

    expect(state.activities).toEqual([]);
    expect(state.status).toBeNull();
    expect(state.position).toBeNull();
  });

  it('lands the request for the last step on the last step there is', () => {
    expect(replayState(STEPS, LAST_STEP).position).toBe(3);
  });
});

describe('clampPosition', () => {
  it('keeps live as live', () => {
    expect(clampPosition(null, 4)).toBeNull();
  });

  it('holds a position inside the list where it is', () => {
    expect(clampPosition(0, 4)).toBe(0);
    expect(clampPosition(2, 4)).toBe(2);
    expect(clampPosition(3, 4)).toBe(3);
  });

  it('brings a position outside the list to its nearest end', () => {
    expect(clampPosition(4, 4)).toBe(3);
    expect(clampPosition(-1, 4)).toBe(0);
  });

  it('answers live when there is nothing to stand on', () => {
    expect(clampPosition(0, 0)).toBeNull();
    expect(clampPosition(LAST_STEP, 0)).toBeNull();
  });
});

describe('stepping', () => {
  it('steps back and forward one at a time', () => {
    expect(stepBack(2, 4)).toBe(1);
    expect(stepForward(2, 4)).toBe(3);
  });

  it('stops at the ends rather than leaving the list', () => {
    expect(stepBack(0, 4)).toBe(0);
    expect(stepForward(3, 4)).toBe(3);
  });

  it('clamps a stale position on the way, as a refresh can leave one', () => {
    expect(stepBack(9, 4)).toBe(2);
    expect(stepForward(9, 4)).toBe(3);
  });

  it('goes to the first and the last step', () => {
    expect(first(4)).toBe(0);
    expect(last(4)).toBe(3);
  });

  it('answers live from every move on an empty list', () => {
    expect(stepBack(0, 0)).toBeNull();
    expect(stepForward(0, 0)).toBeNull();
    expect(first(0)).toBeNull();
    expect(last(0)).toBeNull();
  });
});

describe('replayOffered', () => {
  it('is false while the transcript holds nothing', () => {
    // Whether the read is out, refused or answered empty, there is nothing
    // to walk back through.
    expect(replayOffered(transcript([]))).toBe(false);
    expect(replayOffered({ activities: [], status: 'Reading…', tone: 'muted' })).toBe(false);
    expect(replayOffered({ activities: [], status: 'no', tone: 'blocked' })).toBe(false);
  });

  it('is true once there is at least one activity to stand on', () => {
    expect(replayOffered(transcript(STEPS.slice(0, 1)))).toBe(true);
    expect(replayOffered(transcript(STEPS))).toBe(true);
  });
});
