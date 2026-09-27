import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type ServerView,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { DEFAULT_SHAPE } from '../catalogue/catalogue-model.js';
import {
  ALL_MACHINES,
  fleetCounts,
  machineHeader,
  machineRows,
  machineSelector,
  narrowedToMachine,
} from './machine-selector-model.js';

/**
 * A fleet as a hub really published one. The counts, the rows and the words
 * are all read off a machine state, and a hand-written state would test that
 * this can read what its author imagined a hub sends.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the captured frame is not a machine state');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const degraded = stateFrom(hubFrames.machineStateStale);
const single = stateFrom(hubFrames.machineStateSingle);
const empty = stateFrom(hubFrames.machineState);
/** One connected machine the hub has timed at 12 ms. */
const measured = stateFrom(hubFrames.machineStateMeasured);

/** When `measured` was timed, by the hub's clock. The clock the selector reads at, unless moved. */
const MEASURED_AT = 1_756_000_020_012;
const NOW = MEASURED_AT;

/** The captured timed row, with its figure and its moment varied. */
function timed(ms: number, measuredAt = MEASURED_AT): ServerView {
  const row = measured.servers[0];
  if (row === undefined || row.roundTrip === null) {
    throw new Error('the captured timed fleet has no timed server');
  }
  return { ...row, roundTrip: { ...row.roundTrip, ms, measuredAt } };
}

/** A fleet of the captured timed row, relabelled once per figure. */
function fleetTimedAt(...readings: readonly (readonly [string, ServerView])[]): MachineState {
  return {
    ...measured,
    servers: readings.map(([label, view]) => ({
      ...view,
      label,
      registrationId: view.registrationId.replace(
        'mbp-robert',
        label,
      ) as ServerView['registrationId'],
    })),
  };
}

/**
 * The same captured row with its phase fields varied, which is how the server
 * rows' own suite reaches a phase no capture holds: a hub publishes
 * `connecting` for the moment a dial is in flight, and a capture is taken
 * after it has settled. The row still goes through the frame parser first, so
 * what is varied is a phase and never the shape of a server.
 */
function withPhase(state: MachineState, phase: ServerView['phase']): MachineState {
  const first = state.servers[0];
  if (first === undefined) throw new Error('the captured fleet has no servers');
  return {
    ...state,
    servers: [
      { ...first, phase, connectedSince: null, staleSince: null, staleReason: null, problem: null },
      ...state.servers.slice(1),
    ],
  };
}

describe('how many machines there are and how many are connected', () => {
  it('counts the paired servers and the connected ones', () => {
    expect(fleetCounts(populated)).toEqual({ online: 2, total: 2 });
    expect(fleetCounts(degraded)).toEqual({ online: 1, total: 2 });
    expect(fleetCounts(single)).toEqual({ online: 1, total: 1 });
  });

  it('counts nothing before the first state and nothing for a hub with no pairings', () => {
    expect(fleetCounts(null)).toEqual({ online: 0, total: 0 });
    expect(fleetCounts(empty)).toEqual({ online: 0, total: 0 });
  });

  it('does not count a machine still being dialled as online', () => {
    expect(fleetCounts(withPhase(populated, 'connecting'))).toEqual({ online: 1, total: 2 });
  });
});

describe('the header over the sidebar', () => {
  it('says what is selected and how much of the fleet is up', () => {
    const view = machineSelector(degraded, null, NOW);
    expect(machineHeader(view, 'wide')).toEqual({ title: ALL_MACHINES, detail: '1/2 online' });
  });

  it('compresses to one line where there is no room for two', () => {
    const view = machineSelector(degraded, null, NOW);
    expect(machineHeader(view, 'narrow')).toEqual({
      title: 'All machines · 1/2',
      detail: null,
    });
  });

  it('draws the round trip the hub measured, at either width', () => {
    const view = machineSelector(measured, null, NOW);
    expect(view.latencyMs).toBe(12);
    expect(machineHeader(view, 'wide').detail).toBe('1/1 online · 12ms');
    expect(machineHeader(view, 'narrow').title).toBe('All machines · 1/1 · 12ms');
  });

  it('draws no figure before the first pong, rather than a zero', () => {
    // Connected and not yet timed: the heartbeat's first ping is an interval
    // away, and until it is answered there is nothing to say.
    const view = machineSelector(single, null, NOW);
    expect(view.latencyMs).toBeNull();
    expect(machineHeader(view, 'wide').detail).toBe('1/1 online');
  });

  it('names the machine once one is selected', () => {
    const view = machineSelector(populated, 'registration-gpu-box-01', NOW);
    expect(machineHeader(view, 'wide')).toEqual({ title: 'gpu-box-01', detail: '2/2 online' });
    expect(machineHeader(view, 'narrow').title).toBe('gpu-box-01 · 2/2');
  });

  it('says so rather than claiming a fleet when there is none', () => {
    expect(machineHeader(machineSelector(empty, null, NOW), 'wide')).toEqual({
      title: ALL_MACHINES,
      detail: 'no machines paired',
    });
    expect(machineHeader(machineSelector(null, null, NOW), 'narrow').title).toBe(
      'All machines · no machines paired',
    );
  });

  it('keeps naming a selection the fleet no longer lists, by the id itself', () => {
    // The query is still narrowed to it, so the header says so. A selection
    // silently drawn as "All machines" would disagree with the rows on screen.
    const view = machineSelector(populated, 'registration-unpaired', NOW);
    expect(view.selected).toBe('registration-unpaired');
    expect(machineHeader(view, 'wide').title).toBe('registration-unpaired');
  });
});

describe('the open state: one row per machine', () => {
  it('carries the short label, the full one, a tone and the phase in words', () => {
    const rows = machineSelector(degraded, null, NOW).rows;
    expect(rows.map((row) => row.short)).toEqual(['gpu', 'mbp']);
    expect(rows.map((row) => row.label)).toEqual(['gpu-box-01', 'mbp-robert']);
    // The tones are the server rows' vocabulary, not a second one: connected
    // runs, unreachable is blocked, a dial in flight is idle.
    expect(rows.map((row) => row.tone)).toEqual(['blocked', 'running']);
    expect(rows.map((row) => row.words)).toEqual(['unreachable · dropped', 'connected']);
  });

  it('says which row is the selection', () => {
    const rows = machineSelector(populated, 'registration-mbp-robert', NOW).rows;
    expect(rows.filter((row) => row.selected).map((row) => row.label)).toEqual(['mbp-robert']);
    expect(machineSelector(populated, null, NOW).rows.some((row) => row.selected)).toBe(false);
  });

  it('draws a machine still being dialled as idle rather than alarming', () => {
    const row = machineSelector(withPhase(populated, 'connecting'), null, NOW).rows[0];
    expect(row?.tone).toBe('idle');
    expect(row?.words).toBe('connecting');
  });

  it('does not say a reason that only repeats the phase', () => {
    // The hub's stale reasons and the word for the phase overlap at
    // `unreachable`, and "unreachable · unreachable" says one thing twice.
    const rows = machineSelector(stateFrom(hubFrames.machineStateWithServer), null, NOW).rows;
    expect(rows.map((row) => row.words)).toEqual(['unreachable']);
  });

  it('has no rows before the first state arrives', () => {
    expect(machineSelector(null, null, NOW).rows).toEqual([]);
  });
});

describe('a selection is a filter over sessions, not a place they live', () => {
  it('narrows the catalogue query by the machine, and only by that', () => {
    const narrowed = narrowedToMachine(DEFAULT_SHAPE, 'registration-mbp-robert');
    expect(narrowed.filter).toEqual({ server: 'registration-mbp-robert' });
    expect(narrowed.view).toBe(DEFAULT_SHAPE.view);
    expect(narrowed.sort).toEqual(DEFAULT_SHAPE.sort);
  });

  it('leaves the other narrowings where they are', () => {
    const searched = { ...DEFAULT_SHAPE, filter: { search: 'auth' } };
    expect(narrowedToMachine(searched, 'registration-mbp-robert').filter).toEqual({
      search: 'auth',
      server: 'registration-mbp-robert',
    });
  });

  it('takes the constraint away again when All machines is picked', () => {
    const narrowed = narrowedToMachine(DEFAULT_SHAPE, 'registration-mbp-robert');
    expect(narrowedToMachine(narrowed, null).filter).toEqual({});
  });

  it('reads a control that hands back nothing as no selection at all', () => {
    expect(machineSelector(populated, '', NOW).selected).toBeNull();
    expect(machineSelector(populated, null, NOW).selected).toBeNull();
  });
});

describe('the fleet round trip', () => {
  it('is the mean over the connected machines that have a reading', () => {
    const fleet = fleetTimedAt(['mbp-robert', timed(12)], ['gpu-box-01', timed(72)]);
    expect(machineSelector(fleet, null, NOW).latencyMs).toBe(42);
  });

  it('leaves out a machine that is not online, whatever it last measured', () => {
    // "All machines" is the machines somebody can reach now. A reading on a
    // row that is not connected is not one the hub publishes, and this says
    // so rather than trusting it never happens.
    const offline: ServerView = { ...timed(900), phase: 'stale', connectedSince: null };
    const fleet = fleetTimedAt(['mbp-robert', timed(12)], ['homelab', offline]);
    expect(machineSelector(fleet, null, NOW).latencyMs).toBe(12);
  });

  it('leaves out a machine with no reading instead of counting it as zero', () => {
    const untimed: ServerView = { ...timed(12), roundTrip: null };
    const fleet = fleetTimedAt(['mbp-robert', timed(12)], ['gpu-box-01', untimed]);
    expect(machineSelector(fleet, null, NOW).latencyMs).toBe(12);
  });

  it('leaves out a reading too old to be current, since the header has no room for its age', () => {
    const fleet = fleetTimedAt(
      ['mbp-robert', timed(12)],
      ['gpu-box-01', timed(410, MEASURED_AT - 5 * 60_000)],
    );
    expect(machineSelector(fleet, null, NOW).latencyMs).toBe(12);
    expect(machineSelector(fleetTimedAt(['gpu-box-01', timed(410, 0)]), null, NOW).latencyMs).toBe(
      null,
    );
  });

  it('rounds the mean to a whole millisecond, which is all a round trip is measured in', () => {
    const fleet = fleetTimedAt(['mbp-robert', timed(12)], ['gpu-box-01', timed(61)]);
    expect(machineSelector(fleet, null, NOW).latencyMs).toBe(37);
  });
});

describe("a row's right-hand words", () => {
  it('is the round trip for a machine the hub has timed', () => {
    const [row] = machineSelector(measured, null, NOW).rows;
    expect(row?.trailing).toBe('12ms');
    expect(row?.measured).toBe(true);
    expect(row?.slow).toBe(false);
  });

  it('is marked slow past the threshold, which the row draws in the warning tone', () => {
    const [row] = machineSelector(fleetTimedAt(['ci-runner-eu', timed(410)]), null, NOW).rows;
    expect(row?.trailing).toBe('410ms');
    expect(row?.slow).toBe(true);
  });

  it('carries the age of a reading that is no longer current', () => {
    const [row] = machineSelector(measured, null, MEASURED_AT + 3 * 60_000).rows;
    expect(row?.trailing).toBe('12ms · 3m ago');
  });

  it('is the phase for a machine with no figure to draw', () => {
    const rows = machineSelector(degraded, null, NOW).rows;
    expect(rows.map((row) => row.trailing)).toEqual(['unreachable · dropped', 'connected']);
    expect(rows.some((row) => row.slow || row.measured)).toBe(false);
  });

  it('says a machine is shutting down before it says how fast it answers', () => {
    // A drain is the one thing on this row somebody should act on; a figure
    // for a link that is about to close is not.
    const draining = stateFrom(hubFrames.machineStateDraining);
    const row = draining.servers[0];
    if (row === undefined) throw new Error('the captured drain has no server');
    const reading = timed(410).roundTrip;
    const [drawn] = machineSelector(
      { ...draining, servers: [{ ...row, roundTrip: reading }] },
      null,
      NOW,
    ).rows;
    expect(drawn?.trailing).toBe('shutting down, 1 session finishing');
    expect(drawn?.slow).toBe(false);
  });
});

describe('the rows without a clock', () => {
  it("are the selector's rows, minus the words that need one", () => {
    // What the graph inspector reads: which machines there are and what state
    // each is in, drawn once per state rather than on a clock.
    const rows = machineRows(degraded, null);
    expect(rows.map((row) => row.words)).toEqual(['unreachable · dropped', 'connected']);
    expect(rows[0]).not.toHaveProperty('trailing');
  });
});
