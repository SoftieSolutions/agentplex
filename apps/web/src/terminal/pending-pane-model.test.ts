import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StartedView } from '../store/hub-store.js';
import { pendingSession, pendingWords } from './pending-pane-model.js';

/**
 * What a pane waiting on a start says and becomes, against captured hub
 * output. The started reply, the refusals and the machine state are all frames
 * a real hub sent a real browser; the correlation under test is the one thing
 * a pending pane cannot afford to get wrong.
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
    expect(pendingWords(started.replyTo, null, null, populated)).toEqual({
      kind: 'asking',
      words: 'starting a session',
    });
  });

  it('names the machine the hub picked, by the label the fleet knows it as', () => {
    const words = pendingWords(started.replyTo, started, null, populated);
    expect(words.kind).toBe('starting');
    // The label out of the machine state, not the registration id the reply
    // carried: one spelling of a machine on the screen.
    expect(words.words).toContain('starting on mbp-robert');
    expect(words.words).toContain('becomes the session when the provider names it');
  });

  it('falls back to the registration id rather than hiding which machine it is', () => {
    const words = pendingWords(started.replyTo, started, null, null);
    expect(words.words).toContain('registration-mbp-robert');
  });

  it('says nothing about a start it is not waiting on', () => {
    // A second tab's start, answered to this connection's newest reply slot:
    // correlation is by `replyTo` and there is no other rule.
    expect(pendingWords(started.replyTo + 1, started, null, populated).kind).toBe('asking');
  });

  it('becomes the refusal, in the words the hub used', () => {
    const words = pendingWords(refused.replyTo, null, refused, populated);
    expect(words).toEqual({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
    });
  });

  it('lets a refusal end the wait, over a start that was answered', () => {
    // Both correlated to one handle is not a shape a hub produces, and if it
    // ever did, a pane still saying "starting" over a no would be the blank
    // rectangle this surface exists to replace.
    const both = pendingWords(
      refused.replyTo,
      { ...started, replyTo: refused.replyTo },
      refused,
      populated,
    );
    expect(both.kind).toBe('refused');
  });
});

describe('pendingSession', () => {
  it('has no session while nothing has named one', () => {
    expect(pendingSession(started.replyTo, started, { session: null })).toBeNull();
    expect(pendingSession(started.replyTo, null, null)).toBeNull();
  });

  it('is the session the watched terminal turned out to be', () => {
    expect(pendingSession(started.replyTo, started, { session: SESSION })).toEqual(SESSION);
  });

  it('is the session a resume was answered with, before any output at all', () => {
    const resumed: StartedView = { ...started, sessionId: SESSION.sessionId };
    expect(pendingSession(resumed.replyTo, resumed, null)).toEqual(SESSION);
  });

  it('never takes an answer to another start', () => {
    const resumed: StartedView = {
      ...started,
      replyTo: started.replyTo + 1,
      sessionId: SESSION.sessionId,
    };
    expect(pendingSession(started.replyTo, resumed, null)).toBeNull();
  });
});
