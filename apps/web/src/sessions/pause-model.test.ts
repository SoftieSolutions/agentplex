import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type MachineState,
  type SessionHolder,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { answersOf, replyFrom, withOutstanding } from '../store/replies.fixture.js';
import {
  PAUSE_REQUESTED_WORDS,
  offersPause,
  offersResume,
  pauseButtonWords,
  pauseCommand,
  pauseFollowUp,
  pauseNote,
  resumeCommand,
} from './pause-model.js';

/**
 * The pause rules against captured hub output: the holders a real fleet
 * published, one of them under a pause, and the replies a real hub sent when a
 * pause and a resume landed.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

function holderOf(state: MachineState, sessionId: string): SessionHolder | null {
  for (const store of state.stores) {
    for (const row of store.sessions) {
      if (row.descriptor.sessionId === sessionId) return row.holder;
    }
  }
  throw new Error(`the fixture has no session ${sessionId}`);
}

const withPaused = stateFrom(hubFrames.machineStatePaused);
const paused = replyFrom(hubFrames.sessionPaused, 'session-paused');
const resumed = replyFrom(hubFrames.sessionResumed, 'session-resumed');
const refusal = replyFrom(hubFrames.refusalHeldBusy, 'refusal');
const REF = sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId: 'session-fix-auth' });

describe('offersPause and offersResume', () => {
  it('offers a pause to any held session with no pause on it, busy or not', () => {
    // The busy holder a stop is withheld from is exactly who a pause is for.
    const busy = holderOf(withPaused, 'session-fix-auth');
    const waiting = holderOf(withPaused, 'session-migrate-db');
    expect(busy?.stoppable).toBe(false);
    expect(offersPause(busy)).toBe(true);
    expect(offersPause(waiting)).toBe(true);
    expect(offersResume(busy)).toBe(false);
  });

  it('offers a resume, and no pause, to a paused holder', () => {
    const held = holderOf(withPaused, 'session-docs-index');
    expect(held?.pause).toBe('paused');
    expect(offersResume(held)).toBe(true);
    expect(offersPause(held)).toBe(false);
  });

  it('offers a resume to a requested pause too: that is how a request is taken back', () => {
    const held = holderOf(withPaused, 'session-fix-auth');
    if (held === null) throw new Error('fix-auth is not held');
    const requested = { ...held, pause: 'requested' as const };
    expect(offersResume(requested)).toBe(true);
    expect(offersPause(requested)).toBe(false);
  });

  it('offers neither to a session nobody is running', () => {
    expect(offersPause(null)).toBe(false);
    expect(offersResume(null)).toBe(false);
  });
});

describe('the commands', () => {
  it('carry the session and nothing else', () => {
    expect(pauseCommand(REF)).toEqual({ type: 'session-pause', ...REF });
    expect(resumeCommand(REF)).toEqual({ type: 'session-resume', ...REF });
  });
});

describe('pauseFollowUp', () => {
  // A thin mapping over `followUp` across the two answers a toggle can get.
  const pending = frameIdSchema.parse(paused.replyTo);
  const answers = answersOf(paused, resumed, refusal);

  it('is idle with nothing pending', () => {
    expect(pauseFollowUp(null, answers)).toEqual({ kind: 'idle' });
  });

  it('waits until the answer to its own frame arrives', () => {
    expect(pauseFollowUp(pending, withOutstanding(answersOf(), pending))).toEqual({
      kind: 'waiting',
    });
    // Somebody else's answers are not this one's.
    const other = frameIdSchema.parse(99);
    expect(pauseFollowUp(other, withOutstanding(answers, other))).toEqual({ kind: 'waiting' });
  });

  it('carries the server\u2019s pause word off the captured reply', () => {
    expect(pauseFollowUp(pending, answers)).toEqual({ kind: 'paused', pause: 'requested' });
  });

  it('says resumed off the captured reply', () => {
    expect(pauseFollowUp(resumed.replyTo, answers)).toEqual({ kind: 'resumed' });
  });

  it('shows a refusal in the hub\u2019s words', () => {
    expect(pauseFollowUp(refusal.replyTo, answers)).toEqual({
      kind: 'refused',
      words: refusal.message,
    });
  });
});

describe('the words', () => {
  it('says Pause on a holder with no pause, and Pausing while it waits', () => {
    const held = holderOf(withPaused, 'session-fix-auth');
    expect(pauseButtonWords(held, { kind: 'idle' })).toBe('Pause');
    expect(pauseButtonWords(held, { kind: 'waiting' })).toBe('Pausing');
    expect(pauseNote(held)).toBeNull();
  });

  it('says Resume on a paused holder, and the boundary sentence on a requested one', () => {
    const held = holderOf(withPaused, 'session-docs-index');
    if (held === null) throw new Error('docs-index is not held');
    expect(pauseButtonWords(held, { kind: 'idle' })).toBe('Resume');
    expect(pauseButtonWords(held, { kind: 'waiting' })).toBe('Resuming');
    expect(pauseNote(held)).toBeNull();

    const requested = { ...held, pause: 'requested' as const };
    expect(pauseButtonWords(requested, { kind: 'idle' })).toBe('Resume');
    expect(pauseNote(requested)).toBe(PAUSE_REQUESTED_WORDS);
    expect(PAUSE_REQUESTED_WORDS).toBe('Pausing at the next turn boundary');
  });

  it('reads the button off the holder, not off its own answer', () => {
    // A pause this control asked for landed, and the holder has since been
    // resumed elsewhere: the button offers what the fleet says, a Pause.
    const held = holderOf(withPaused, 'session-fix-auth');
    expect(pauseButtonWords(held, { kind: 'paused', pause: 'paused' })).toBe('Pause');
  });
});
