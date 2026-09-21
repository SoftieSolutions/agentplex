import { describe, expect, it } from 'vitest';
import type { FrameId } from '@agentplex/protocol';
import { transcriptState, TRANSCRIPT_COUNT } from './transcript-model.js';

/**
 * What the Transcript tab says, and when.
 *
 * Every case here is one a person actually meets: a tab opened on a slow disk,
 * a machine that has gone away, a session that has not done anything a
 * transcript can show, and an answer to the other pane's question arriving in
 * the store this pane is reading.
 */

const ASKED = 7 as FrameId;

const RAN = { kind: 'command', text: 'pnpm test', exitStatus: 1 } as const;

function answer(replyTo: number, olderExist: boolean) {
  return { replyTo: replyTo as FrameId, activities: [RAN], olderExist };
}

function refusal(replyTo: number, message: string) {
  return { replyTo: replyTo as FrameId, code: 'refused' as const, message, holder: null };
}

describe('transcriptState', () => {
  it('says the transcript has not been read before anything has been asked', () => {
    // "We have not looked" and "there is nothing there" are different facts,
    // and a tab that showed the second before asking would be inventing one.
    const state = transcriptState(null, null, null);

    expect(state).toEqual({
      activities: [],
      status: 'This session’s transcript has not been read yet.',
      tone: 'muted',
    });
  });

  it('says it is reading while the answer is still crossing two machines', () => {
    const state = transcriptState(ASKED, null, null);

    expect(state.activities).toEqual([]);
    expect(state.status).toBe('Reading this session’s transcript…');
    expect(state.tone).toBe('muted');
  });

  it('draws the activities the machine answered, oldest first and untouched', () => {
    const state = transcriptState(ASKED, answer(7, false), null);

    expect(state).toEqual({ activities: [RAN], status: null, tone: 'muted' });
  });

  it('says out loud when the session did more than the bound carries', () => {
    const state = transcriptState(ASKED, answer(7, true), null);

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toContain('Showing the last 1');
    expect(state.status).toContain('stays on the machine');
  });

  it('says a session with nothing to show has nothing, rather than nothing at all', () => {
    // A blank panel reads as a screen that failed to load. A sentence reads as
    // an answer, which is what it is.
    const state = transcriptState(
      ASKED,
      { replyTo: ASKED, activities: [], olderExist: false },
      null,
    );

    expect(state.status).toBe('This session’s transcript holds nothing this view can show yet.');
    expect(state.tone).toBe('muted');
  });

  it('shows the hub’s own sentence when it refused this pane’s read', () => {
    const state = transcriptState(
      ASKED,
      null,
      refusal(7, 'no server with that store mounted is connected right now'),
    );

    expect(state).toEqual({
      activities: [],
      status: 'no server with that store mounted is connected right now',
      tone: 'blocked',
    });
  });

  it('ignores a refusal that answered somebody else’s frame', () => {
    // The store keeps the newest "no" on the whole connection. A stop somebody
    // pressed in another pane is not a reason this transcript is empty.
    const state = transcriptState(ASKED, answer(7, false), refusal(99, 'that session is mid-turn'));

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toBeNull();
  });

  it('ignores an answer to an earlier ask, and keeps saying it is reading', () => {
    // The refresh case: a second read is in flight and the slot still holds
    // the first one's answer. Drawing that would be showing a history as of
    // before the button was pressed.
    const state = transcriptState(ASKED, answer(3, false), null);

    expect(state.activities).toEqual([]);
    expect(state.status).toBe('Reading this session’s transcript…');
  });

  it('asks for what one frame will carry, and never more', () => {
    // The count is the protocol's ceiling, so `olderExist` is a fact about the
    // file rather than about a bound this screen picked for itself.
    expect(TRANSCRIPT_COUNT).toBe(200);
  });
});
