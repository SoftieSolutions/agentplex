import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  storeIdSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StartedView, StartView } from '../store/views.js';
import {
  NAMING_BOUND_MS,
  pendingSession,
  pendingWords,
  startAwaited,
  startLive,
  startShown,
  type StartMoment,
} from './pending-pane-model.js';

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

/** When the captured yes was read, by the client's clock. */
const ANSWERED_AT = 1_000_000;

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
    receivedAt: ANSWERED_AT,
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

/** What the captured start asked for; neither function reads it. */
const asked = {
  storeId: storeIdSchema.parse('store-agentplex'),
  provider: 'claude',
  project: null,
} as const;

describe('pendingWords', () => {
  it('says only that it is asking, until the hub has answered', () => {
    // The entry the store opens the moment a start is accepted: asked, and
    // answered neither way. A pane has to be able to say something then.
    expect(
      pendingWords({ asked, started: null, refusal: null, named: null, sentOn: 1 }, populated),
    ).toEqual({
      kind: 'asking',
      words: 'starting a session',
    });
    // And the same for a pane whose start the store has no entry for at all,
    // which is a handle that outlived the connection it was minted on.
    expect(pendingWords(null, populated).kind).toBe('asking');
  });

  it('names the machine the hub picked, once it has said so', () => {
    const words = pendingWords(
      { asked, started, refusal: null, named: null, sentOn: 1 },
      populated,
    );
    expect(words.kind).toBe('starting');
    // The label out of the machine state, not the registration id the reply
    // carried: one spelling of a machine on the screen.
    expect(words.words).toContain('starting on mbp-robert');
    expect(words.words).toContain('becomes the session when the provider names it');
  });

  it('falls back to the registration id rather than hiding which machine it is', () => {
    const words = pendingWords({ asked, started, refusal: null, named: null, sentOn: 1 }, null);
    expect(words.words).toContain('registration-mbp-robert');
  });

  it('becomes the refusal, in the words the hub used', () => {
    expect(
      pendingWords({ asked, started: null, refusal: refused, named: null, sentOn: 1 }, populated),
    ).toEqual({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
    });
  });

  it('lets a refusal end the wait, over a start that was answered', () => {
    // Both on one entry is not a shape the store writes -- a start is answered
    // once -- and if it ever were, a pane still saying "starting" over a
    // machine that said no would be the blank rectangle this surface exists to
    // replace.
    expect(
      pendingWords({ asked, started, refusal: refused, named: null, sentOn: 1 }, populated).kind,
    ).toBe('refused');
  });
});

describe('pendingSession', () => {
  it('has no session while nothing has named one', () => {
    expect(
      pendingSession({ asked, started, refusal: null, named: null, sentOn: 1 }, { session: null }),
    ).toBeNull();
    expect(pendingSession(null, null)).toBeNull();
  });

  it('is the session the watched terminal turned out to be', () => {
    expect(
      pendingSession(
        { asked, started, refusal: null, named: null, sentOn: 1 },
        { session: SESSION },
      ),
    ).toEqual(SESSION);
  });

  it('is the session a resume was answered with, before any output at all', () => {
    const resumed: StartedView = { ...started, sessionId: SESSION.sessionId };
    expect(
      pendingSession({ asked, started: resumed, refusal: null, named: null, sentOn: 1 }, null),
    ).toEqual(SESSION);
  });

  it('is the session the hub said the start became, with no terminal open on it', () => {
    expect(
      pendingSession({ asked, started, refusal: null, named: SESSION, sentOn: 1 }, null),
    ).toEqual(SESSION);
  });

  it('takes the session a resume was answered with over any naming', () => {
    const resumed: StartedView = { ...started, sessionId: SESSION.sessionId };
    const other = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-spawned' });
    expect(
      pendingSession({ asked, started: resumed, refusal: null, named: other, sentOn: 1 }, null),
    ).toEqual(SESSION);
  });

  it('is nothing at all for a start that was refused', () => {
    const entry: StartView = { asked, started: null, refusal: refused, named: null, sentOn: 1 };
    expect(pendingSession(entry, null)).toBeNull();
  });
});

describe('startAwaited', () => {
  /** On the connection the start went out on, a second after its yes. */
  const soon: StartMoment = { connection: 1, phase: 'connected', now: ANSWERED_AT + 1_000 };
  const placed: StartView = { asked, started, refusal: null, named: null, sentOn: 1 };

  it('is awaited while the hub has not answered, on the connection that carried it', () => {
    expect(startAwaited({ ...placed, started: null }, soon)).toBe(true);
  });

  it('is awaited while queued, because it has not been sent anywhere yet', () => {
    expect(startAwaited({ ...placed, started: null, sentOn: null }, soon)).toBe(true);
  });

  it('is awaited after the yes and inside the bound', () => {
    const edge = { ...soon, now: ANSWERED_AT + NAMING_BOUND_MS - 1 };
    expect(startAwaited(placed, edge)).toBe(true);
  });

  it('is not awaited once the bound has passed without a name', () => {
    const late = { ...soon, now: ANSWERED_AT + NAMING_BOUND_MS };
    expect(startAwaited(placed, late)).toBe(false);
  });

  it('is not awaited on a connection after the one that carried it', () => {
    // The hub names a start down the socket that made it and drops that
    // socket's handles on close: nothing more about it can arrive.
    expect(startAwaited(placed, { ...soon, connection: 2 })).toBe(false);
    expect(startAwaited({ ...placed, started: null }, { ...soon, connection: 2 })).toBe(false);
  });

  it('is not awaited once refused: the answer it was owed has arrived', () => {
    expect(startAwaited({ ...placed, started: null, refusal: refused }, soon)).toBe(false);
  });

  it('is not awaited once the connection that carried it is down, before any redial', () => {
    // The hub forgets a socket's start handles at the close, not at the next
    // welcome: a store backing off through a long outage, or one stopped by a
    // protocol-version refusal, never counts another welcome, and the start
    // is beyond naming all the same.
    for (const phase of ['reconnecting', 'connecting', 'failed'] as const) {
      expect(startAwaited(placed, { ...soon, phase })).toBe(false);
      expect(startAwaited({ ...placed, started: null }, { ...soon, phase })).toBe(false);
    }
  });

  it('is awaited while queued and the connection is down, because it goes out on the next', () => {
    const down: StartMoment = { ...soon, phase: 'reconnecting' };
    expect(startAwaited({ ...placed, started: null, sentOn: null }, down)).toBe(true);
  });
});

describe('startLive', () => {
  const soon: StartMoment = { connection: 1, phase: 'connected', now: ANSWERED_AT + 1_000 };
  const late: StartMoment = { ...soon, now: ANSWERED_AT + NAMING_BOUND_MS + 10_000 };
  const placed: StartView = { asked, started, refusal: null, named: null, sentOn: 1 };
  const relayed = { session: null, attached: true, ended: null };

  it('is live while awaited, terminal or none', () => {
    expect(startLive(placed, null, soon)).toBe(true);
  });

  it('stays live past the bound while its terminal is relayed on the connection that carried it', () => {
    expect(startLive(placed, relayed, late)).toBe(true);
  });

  it('is not live past the bound once its terminal ends, detaches, or its connection goes', () => {
    expect(startLive(placed, null, late)).toBe(false);
    expect(startLive(placed, { ...relayed, attached: false, ended: 'session-ended' }, late)).toBe(
      false,
    );
    expect(startLive(placed, { ...relayed, attached: false }, late)).toBe(false);
    expect(startLive(placed, relayed, { ...late, phase: 'reconnecting' })).toBe(false);
    expect(startLive(placed, relayed, { ...late, connection: 2 })).toBe(false);
  });

  it('is not live once refused, whatever a terminal says', () => {
    expect(startLive({ ...placed, started: null, refusal: refused }, relayed, soon)).toBe(false);
  });
});

describe('startShown', () => {
  const soon: StartMoment = { connection: 1, phase: 'connected', now: ANSWERED_AT + 1_000 };
  const late: StartMoment = { ...soon, now: ANSWERED_AT + NAMING_BOUND_MS };
  const later: StartMoment = { ...soon, connection: 2 };
  /** The connection that carried the start, dropped and not yet replaced. */
  const down: StartMoment = { ...soon, phase: 'reconnecting' };
  const placed: StartView = { asked, started, refusal: null, named: null, sentOn: 1 };
  const quiet = { session: null, attached: false, ended: null };

  it('shows nothing for a start this tab does not hold', () => {
    expect(startShown(null, null, soon)).toBe(false);
  });

  it('shows a start that may still be answered or named', () => {
    expect(startShown(placed, null, soon)).toBe(true);
  });

  it('shows a named start whenever, because what it shows is the session', () => {
    expect(startShown({ ...placed, named: SESSION }, null, later)).toBe(true);
    expect(startShown({ ...placed, named: SESSION }, null, late)).toBe(true);
  });

  it('shows a refused start, whose pane says the hub said no', () => {
    const entry: StartView = { ...placed, started: null, refusal: refused };
    expect(startShown(entry, null, later)).toBe(true);
  });

  it('shows no pane for a start from an earlier connection, which can only be refused', () => {
    expect(startShown(placed, quiet, later)).toBe(false);
  });

  it('shows no pane for a placed start once the connection that carried it is down', () => {
    expect(startShown(placed, quiet, down)).toBe(false);
    expect(startShown(placed, quiet, { ...down, phase: 'failed' })).toBe(false);
  });

  it('shows no pane for a start past the bound with nothing relaying it', () => {
    expect(startShown(placed, quiet, late)).toBe(false);
    expect(startShown(placed, { ...quiet, attached: true, ended: 'session-ended' }, late)).toBe(
      false,
    );
  });

  it('keeps the pane of a start past the bound while the hub is relaying its terminal', () => {
    // A spawn given no prompt writes no session until somebody types into it,
    // and the pane they are typing into is not one to take away from them.
    expect(startShown(placed, { ...quiet, attached: true }, late)).toBe(true);
  });
});
