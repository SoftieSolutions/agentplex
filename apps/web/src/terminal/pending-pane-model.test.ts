import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StartedView, StartView } from '../store/hub-store.js';
import { pendingSession, pendingWords } from './pending-pane-model.js';

/**
 * What a pane waiting on a start says and becomes, against captured hub
 * output. The started reply, the refusals and the machine state are all frames
 * a real hub sent a real browser.
 *
 * What a pane is given is the entry the store filed for its own start, so
 * there is no correlation left to get wrong here -- that rule is the store's,
 * and `hub-store.test.ts` holds it. What is left is what the two answers read
 * as, and the order the two of them are read in.
 */

function startedFrom(text: string): StartedView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-started') {
    throw new Error('the fixture is not a session-started frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    storeId: frame.storeId,
    sessionId: frame.sessionId,
    server: frame.server,
  };
}

function refusalFrom(text: string): RefusalView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'refusal') {
    throw new Error('the fixture is not a refusal frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    code: frame.code,
    message: frame.message,
    holder: frame.holder,
  };
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** The captured start: a fresh spawn, so the reply names no session. */
const started = startedFrom(hubFrames.sessionStarted);
const refused = refusalFrom(hubFrames.refusal);
const populated = stateFrom(hubFrames.machineStatePopulated);
const SESSION = sessionRefSchema.parse({
  storeId: 'store-agentplex',
  sessionId: 'session-migrate-db',
});

describe('pendingWords', () => {
  it('says only that it is asking, until the hub has answered', () => {
    // The entry the store opens the moment a start is accepted: asked, and
    // answered neither way. A pane has to be able to say something then.
    expect(pendingWords({ started: null, refusal: null }, populated)).toEqual({
      kind: 'asking',
      words: 'starting a session',
    });
    // And the same for a pane whose start the store has no entry for at all,
    // which is a handle that outlived the connection it was minted on.
    expect(pendingWords(null, populated).kind).toBe('asking');
  });

  it('names the machine the hub picked, once it has said so', () => {
    const words = pendingWords({ started, refusal: null }, populated);
    expect(words.kind).toBe('starting');
    // The label out of the machine state, not the registration id the reply
    // carried: one spelling of a machine on the screen.
    expect(words.words).toContain('starting on mbp-robert');
    expect(words.words).toContain('becomes the session when the provider names it');
  });

  it('falls back to the registration id rather than hiding which machine it is', () => {
    const words = pendingWords({ started, refusal: null }, null);
    expect(words.words).toContain('registration-mbp-robert');
  });

  it('becomes the refusal, in the words the hub used', () => {
    expect(pendingWords({ started: null, refusal: refused }, populated)).toEqual({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
    });
  });

  it('lets a refusal end the wait, over a start that was answered', () => {
    // Both on one entry is not a shape the store writes -- a start is answered
    // once -- and if it ever were, a pane still saying "starting" over a
    // machine that said no would be the blank rectangle this surface exists to
    // replace.
    expect(pendingWords({ started, refusal: refused }, populated).kind).toBe('refused');
  });
});

describe('pendingSession', () => {
  it('has no session while nothing has named one', () => {
    expect(pendingSession({ started, refusal: null }, { session: null })).toBeNull();
    expect(pendingSession(null, null)).toBeNull();
  });

  it('is the session the watched terminal turned out to be', () => {
    expect(pendingSession({ started, refusal: null }, { session: SESSION })).toEqual(SESSION);
  });

  it('is the session a resume was answered with, before any output at all', () => {
    const resumed: StartedView = { ...started, sessionId: SESSION.sessionId };
    expect(pendingSession({ started: resumed, refusal: null }, null)).toEqual(SESSION);
  });

  it('is nothing at all for a start that was refused', () => {
    const entry: StartView = { started: null, refusal: refused };
    expect(pendingSession(entry, null)).toBeNull();
  });
});
