import { describe, expect, it } from 'vitest';
import type { Activity, FrameId } from '@agentplex/protocol';
import type { TranscriptView } from '../store/hub-store.js';
import { transcriptState, TRANSCRIPT_COUNT } from './transcript-model.js';

/**
 * What the Transcript tab says, and when.
 *
 * Every case here is one a person actually meets: a tab opened on a slow disk,
 * a machine that has gone away, a session that has not done anything a
 * transcript can show, a refresh in flight over a list that is already drawn,
 * and the other pane on this session being answered while this one looks at it.
 */

const ASKED = 7 as FrameId;
const ASKED_AGAIN = 11 as FrameId;
const SOMEBODY_ELSE = 99 as FrameId;

const RAN = { kind: 'command', text: 'pnpm test', exitStatus: 1 } as const;
const RAN_AGAIN = { kind: 'command', text: 'pnpm lint', exitStatus: 0 } as const;

function answer(
  replyTo: FrameId,
  olderExist: boolean,
  activities: readonly Activity[] = [RAN],
): TranscriptView {
  return { replyTo, activities, olderExist };
}

/** The store's map, written the way the store publishes it. */
function held(...answers: readonly TranscriptView[]): ReadonlyMap<FrameId, TranscriptView> {
  return new Map(answers.map((one) => [one.replyTo, one]));
}

function refusal(replyTo: FrameId, message: string) {
  return { replyTo, code: 'refused' as const, message, holder: null };
}

describe('transcriptState', () => {
  it('says the transcript has not been read before anything has been asked', () => {
    // "We have not looked" and "there is nothing there" are different facts,
    // and a tab that showed the second before asking would be inventing one.
    const state = transcriptState(null, held(), null);

    expect(state).toEqual({
      activities: [],
      status: 'This session’s transcript has not been read yet.',
      tone: 'muted',
    });
  });

  it('says it is reading while the answer is still crossing two machines', () => {
    const state = transcriptState({ latest: ASKED, answered: null }, held(), null);

    expect(state.activities).toEqual([]);
    expect(state.status).toBe('Reading this session’s transcript…');
    expect(state.tone).toBe('muted');
  });

  it('draws the activities the machine answered, oldest first and untouched', () => {
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, false)),
      null,
    );

    expect(state).toEqual({ activities: [RAN], status: null, tone: 'muted' });
  });

  it('says out loud when the session did more than the bound carries', () => {
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, true)),
      null,
    );

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toContain('Showing the last 1');
    expect(state.status).toContain('stays on the machine');
  });

  it('says a session with nothing to show has nothing, rather than nothing at all', () => {
    // A blank panel reads as a screen that failed to load. A sentence reads as
    // an answer, which is what it is.
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, false, [])),
      null,
    );

    expect(state.status).toBe('This session’s transcript holds nothing this view can show yet.');
    expect(state.tone).toBe('muted');
  });

  it('says there is more behind an empty answer that was cut short', () => {
    // The window the machine read held no complete activity at all -- one line
    // longer than the tail it reads is enough -- and it said so by cutting the
    // answer short. "Nothing to show" would be a claim about the session; the
    // truth is a claim about this view.
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, true, [])),
      null,
    );

    expect(state.activities).toEqual([]);
    expect(state.status).toBe(
      'Nothing in the end of this session’s transcript could be read into this view, and there is more of it on the machine that holds the file.',
    );
    expect(state.tone).toBe('muted');
  });

  it('shows the hub’s own sentence when it refused this pane’s read', () => {
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(),
      refusal(ASKED, 'no server with that store mounted is connected right now'),
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
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, false)),
      refusal(SOMEBODY_ELSE, 'that session is mid-turn'),
    );

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toBeNull();
  });

  it('keeps the list it has while a refresh is in flight, and says it is reading', () => {
    // A refresh asks the same question again. Blanking the list until the
    // answer lands loses something true -- what the session had done as of the
    // last read -- and gains nothing, because the sentence beside it already
    // says a read is out. Nothing here claims the list is current.
    const state = transcriptState(
      { latest: ASKED_AGAIN, answered: ASKED },
      held(answer(ASKED, false)),
      null,
    );

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toBe('Reading this session’s transcript…');
    expect(state.tone).toBe('muted');
  });

  it('draws the refresh’s own answer the moment it lands', () => {
    const state = transcriptState(
      { latest: ASKED_AGAIN, answered: ASKED },
      held(answer(ASKED, false), answer(ASKED_AGAIN, false, [RAN_AGAIN])),
      null,
    );

    expect(state.activities).toEqual([RAN_AGAIN]);
    expect(state.status).toBeNull();
  });

  it('keeps the list beside the hub’s no when the refresh itself was refused', () => {
    // The read failed; what was read before it did not stop being true. The
    // sentence is the hub's own and the tone is the blocked one, so nothing
    // here presents the list as fresh.
    const state = transcriptState(
      { latest: ASKED_AGAIN, answered: ASKED },
      held(answer(ASKED, false)),
      refusal(ASKED_AGAIN, 'no server with that store mounted is connected right now'),
    );

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toBe('no server with that store mounted is connected right now');
    expect(state.tone).toBe('blocked');
  });

  it('is untouched by an answer to the other pane on this session', () => {
    // Two panes on one session, both on Transcript. The other pane's answer is
    // in the same map, under the id *it* asked with; this pane reads its own
    // and neither its list nor its silence moves.
    const state = transcriptState(
      { latest: ASKED, answered: null },
      held(answer(ASKED, false), answer(SOMEBODY_ELSE, true, [RAN_AGAIN])),
      null,
    );

    expect(state.activities).toEqual([RAN]);
    expect(state.status).toBeNull();
  });

  it('never says it is reading when this pane has no read outstanding', () => {
    // The over-claim this model exists to prevent: a sentence saying a machine
    // is being asked something when nothing is being asked of it. Every state
    // reachable with this pane's own answer in hand is one of the four the tab
    // draws a list under.
    for (const one of [
      answer(ASKED, false),
      answer(ASKED, true),
      answer(ASKED, false, []),
      answer(ASKED, true, []),
    ]) {
      const state = transcriptState(
        { latest: ASKED, answered: null },
        held(one, answer(SOMEBODY_ELSE, true, [RAN_AGAIN])),
        null,
      );

      expect(state.status ?? '').not.toContain('Reading this session');
    }
  });

  it('asks for what one frame will carry, and never more', () => {
    // The count is the protocol's ceiling, so `olderExist` is a fact about the
    // file rather than about a bound this screen picked for itself.
    expect(TRANSCRIPT_COUNT).toBe(200);
  });
});
