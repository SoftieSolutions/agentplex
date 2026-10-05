import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  sessionRefSchema,
  storeIdSchema,
  type FrameId,
  type Layout,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { terminalKey } from '../store/terminals.js';
import type { RefusalView, StartedView, StartView } from '../store/views.js';
import {
  NAMING_BOUND_MS,
  type NamedTerminal,
  type StartMoment,
} from '../terminal/pending-pane-model.js';
import { pendingRows, withPendingRows, type PendingRow } from './pending-rows-model.js';
import { listSessions, orderByActivity, partitionNeedsYou } from './session-list-model.js';

/**
 * The sidebar's rows for starts that have no session yet, against captured hub
 * output: the yes, the refusal, the fleet and the tree are frames a real hub
 * sent. The rule under test is the one the ticket names -- a row from the
 * moment the hub accepts a start until the moment it names what the start
 * became, and never for a start it refused.
 */

function frameOf(text: string) {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error('the fixture is not a hub frame');
  return parsed.value;
}

/** When the captured yes was read, by the client's clock. */
const ANSWERED_AT = 1_000_000;
/** On the first connection, which carried every start below, a second after the yes. */
const NOW: StartMoment = { connection: 1, phase: 'connected', now: ANSWERED_AT + 1_000 };

function startedFrom(text: string): StartedView {
  const frame = frameOf(text);
  if (frame.type !== 'session-started')
    throw new Error('the fixture is not a session-started frame');
  return {
    replyTo: frame.replyTo,
    storeId: frame.storeId,
    sessionId: frame.sessionId,
    server: frame.server,
    receivedAt: ANSWERED_AT,
  };
}

function refusalFrom(text: string): RefusalView {
  const frame = frameOf(text);
  if (frame.type !== 'refusal') throw new Error('the fixture is not a refusal frame');
  return {
    replyTo: frame.replyTo,
    code: frame.code,
    message: frame.message,
    holder: frame.holder,
  };
}

function stateFrom(text: string): MachineState {
  const frame = frameOf(text);
  if (frame.type !== 'machine-state') throw new Error('the fixture is not a machine-state frame');
  return frame.state;
}

function layoutFrom(text: string): Layout {
  const frame = frameOf(text);
  if (frame.type !== 'layout') throw new Error('the fixture is not a layout frame');
  return frame.nodes;
}

/** A fresh spawn the hub placed on mbp-robert, answering frame 2. */
const started = startedFrom(hubFrames.sessionStarted);
const refused = refusalFrom(hubFrames.refusal);
const populated = stateFrom(hubFrames.machineStatePopulated);
/** The captured tree, whose one project is `hub-5`. */
const layout = layoutFrom(hubFrames.layoutWithProject);

const START = frameIdSchema.parse(2);
const PROJECT = nodeIdSchema.parse('hub-5');
const MBP = serverRegistrationIdSchema.parse('registration-mbp-robert');
const GPU = serverRegistrationIdSchema.parse('registration-gpu-box-01');
const NAMED = sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId: 'session-new' });

const asked = {
  storeId: storeIdSchema.parse('store-agentplex'),
  provider: 'claude',
  project: PROJECT,
} as const;

function startsOf(entries: readonly (readonly [FrameId, StartView])[]) {
  return new Map(entries);
}

const NO_TERMINALS = new Map<string, NamedTerminal>();

describe('pendingRows', () => {
  it('draws nothing for a start the hub has not answered', () => {
    const starts = startsOf([
      [START, { asked, started: null, refusal: null, named: null, sentOn: 1 }],
    ]);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, NOW)).toEqual([]);
  });

  it('draws nothing for a start the hub refused', () => {
    const starts = startsOf([
      [START, { asked, started: null, refusal: refused, named: null, sentOn: 1 }],
    ]);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, NOW)).toEqual([]);
  });

  it('draws nothing for a start the hub has named', () => {
    const starts = startsOf([[START, { asked, started, refusal: null, named: NAMED, sentOn: 1 }]]);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, NOW)).toEqual([]);
  });

  it('draws nothing for a start a pane watching it has named', () => {
    // The pane's subscription learnt the session before any naming frame
    // reached the store: a row beside the session's own would be one agent
    // listed twice.
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    const terminals = new Map<string, NamedTerminal>([
      [terminalKey({ by: 'start', startId: START }), { session: NAMED }],
    ]);
    expect(pendingRows(starts, terminals, populated, layout, null, NOW)).toEqual([]);
  });

  it('draws an accepted start the provider has not named, off what it asked for', () => {
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    const expected: PendingRow = {
      startId: START,
      provider: 'claude',
      storeId: asked.storeId,
      project: 'agentplex (main checkout)',
      machine: 'mbp-robert',
      words: 'starting',
    };
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, NOW)).toEqual([expected]);
  });

  it('names no project for a start filed under none, or under one the tree no longer has', () => {
    const none = startsOf([
      [
        START,
        { asked: { ...asked, project: null }, started, refusal: null, named: null, sentOn: 1 },
      ],
    ]);
    expect(pendingRows(none, NO_TERMINALS, populated, layout, null, NOW)[0]?.project).toBeNull();
    const gone = startsOf([
      [
        START,
        {
          asked: { ...asked, project: nodeIdSchema.parse('hub-99') },
          started,
          refusal: null,
          named: null,
          sentOn: 1,
        },
      ],
    ]);
    expect(pendingRows(gone, NO_TERMINALS, populated, layout, null, NOW)[0]?.project).toBeNull();
    // And before the tree has been answered at all.
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    expect(pendingRows(starts, NO_TERMINALS, populated, null, null, NOW)[0]?.project).toBeNull();
  });

  it('spells the machine as the registration id while there is no fleet to look it up in', () => {
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    expect(pendingRows(starts, NO_TERMINALS, null, layout, null, NOW)[0]?.machine).toBe(MBP);
  });

  it('keeps a start on the chosen machine and drops one on another', () => {
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, MBP, NOW)).toHaveLength(1);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, GPU, NOW)).toEqual([]);
  });

  it('draws nothing on a fresh connection for a start the last one carried', () => {
    // The connection dropped between the yes and the naming. The hub sends the
    // name only down the socket that made the start, and forgot that socket's
    // handles when it closed, so the row would say "starting" for good beside
    // the session's own row once the scan finds it.
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    const reconnected = { ...NOW, connection: 2 };
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, reconnected)).toEqual([]);
  });

  it('draws nothing for a placed start once the connection that carried it is down', () => {
    // No welcome has been counted, so the connection number still matches;
    // the socket that could have carried the name is closed all the same.
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    for (const phase of ['reconnecting', 'failed'] as const) {
      expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, { ...NOW, phase })).toEqual(
        [],
      );
    }
  });

  it('stops drawing a start as starting once the bound passes without a name', () => {
    const starts = startsOf([[START, { asked, started, refusal: null, named: null, sentOn: 1 }]]);
    const inside = { ...NOW, now: ANSWERED_AT + NAMING_BOUND_MS - 1 };
    const past = { ...NOW, now: ANSWERED_AT + NAMING_BOUND_MS };
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, inside)).toHaveLength(1);
    expect(pendingRows(starts, NO_TERMINALS, populated, layout, null, past)).toEqual([]);
  });

  it('puts the start asked most recently first', () => {
    const later = frameIdSchema.parse(9);
    const starts = startsOf([
      [START, { asked, started, refusal: null, named: null, sentOn: 1 }],
      [
        later,
        { asked, started: { ...started, replyTo: later }, refusal: null, named: null, sentOn: 1 },
      ],
    ]);
    expect(
      pendingRows(starts, NO_TERMINALS, populated, layout, null, NOW).map((row) => row.startId),
    ).toEqual([later, START]);
  });
});

describe('withPendingRows', () => {
  const items = partitionNeedsYou(orderByActivity(listSessions(populated)));
  const row: PendingRow = {
    startId: START,
    provider: 'claude',
    storeId: asked.storeId,
    project: null,
    machine: 'mbp-robert',
    words: 'starting',
  };

  it('pins needs-you rows, then the pending ones, then the rest', () => {
    const needing = items.filter((item) => item.needsYou);
    const rest = items.filter((item) => !item.needsYou);
    // The fixture has both halves, or this would pin nothing.
    expect(needing).not.toHaveLength(0);
    expect(rest).not.toHaveLength(0);

    expect(withPendingRows(items, [row])).toEqual([
      ...needing.map((item) => ({ kind: 'session', item })),
      { kind: 'pending', row },
      ...rest.map((item) => ({ kind: 'session', item })),
    ]);
  });

  it('is the sessions alone with nothing pending, and the pending alone with no sessions', () => {
    expect(withPendingRows(items, []).map((entry) => entry.kind)).toEqual(
      items.map(() => 'session'),
    );
    expect(withPendingRows([], [row])).toEqual([{ kind: 'pending', row }]);
  });
});
