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
  machineSelector,
  narrowedToMachine,
  NO_LATENCY_MS,
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
    const view = machineSelector(degraded, null);
    expect(machineHeader(view, 'wide')).toEqual({ title: ALL_MACHINES, detail: '1/2 online' });
  });

  it('compresses to one line where there is no room for two', () => {
    const view = machineSelector(degraded, null);
    expect(machineHeader(view, 'narrow')).toEqual({
      title: 'All machines · 1/2',
      detail: null,
    });
  });

  it('draws a round trip only when one has been measured, at either width', () => {
    // Nothing publishes a latency in this build, so this is the slot rather
    // than a reading: a number handed in here is drawn, and none is invented.
    const measured = machineSelector(degraded, null, 42);
    expect(machineHeader(measured, 'wide').detail).toBe('1/2 online · 42ms');
    expect(machineHeader(measured, 'narrow').title).toBe('All machines · 1/2 · 42ms');
    expect(machineHeader(machineSelector(degraded, null), 'wide').detail).toBe('1/2 online');
  });

  it('names the machine once one is selected', () => {
    const view = machineSelector(populated, 'registration-gpu-box-01');
    expect(machineHeader(view, 'wide')).toEqual({ title: 'gpu-box-01', detail: '2/2 online' });
    expect(machineHeader(view, 'narrow').title).toBe('gpu-box-01 · 2/2');
  });

  it('says so rather than claiming a fleet when there is none', () => {
    expect(machineHeader(machineSelector(empty, null), 'wide')).toEqual({
      title: ALL_MACHINES,
      detail: 'no machines paired',
    });
    expect(machineHeader(machineSelector(null, null), 'narrow').title).toBe(
      'All machines · no machines paired',
    );
  });

  it('keeps naming a selection the fleet no longer lists, by the id itself', () => {
    // The query is still narrowed to it, so the header says so. A selection
    // silently drawn as "All machines" would disagree with the rows on screen.
    const view = machineSelector(populated, 'registration-unpaired');
    expect(view.selected).toBe('registration-unpaired');
    expect(machineHeader(view, 'wide').title).toBe('registration-unpaired');
  });
});

describe('the open state: one row per machine', () => {
  it('carries the short label, the full one, a tone and the phase in words', () => {
    const rows = machineSelector(degraded, null).rows;
    expect(rows.map((row) => row.short)).toEqual(['gpu', 'mbp']);
    expect(rows.map((row) => row.label)).toEqual(['gpu-box-01', 'mbp-robert']);
    // The tones are the server rows' vocabulary, not a second one: connected
    // runs, unreachable is blocked, a dial in flight is idle.
    expect(rows.map((row) => row.tone)).toEqual(['blocked', 'running']);
    expect(rows.map((row) => row.words)).toEqual(['unreachable · dropped', 'connected']);
  });

  it('says which row is the selection', () => {
    const rows = machineSelector(populated, 'registration-mbp-robert').rows;
    expect(rows.filter((row) => row.selected).map((row) => row.label)).toEqual(['mbp-robert']);
    expect(machineSelector(populated, null).rows.some((row) => row.selected)).toBe(false);
  });

  it('draws a machine still being dialled as idle rather than alarming', () => {
    const row = machineSelector(withPhase(populated, 'connecting'), null).rows[0];
    expect(row?.tone).toBe('idle');
    expect(row?.words).toBe('connecting');
  });

  it('does not say a reason that only repeats the phase', () => {
    // The hub's stale reasons and the word for the phase overlap at
    // `unreachable`, and "unreachable · unreachable" says one thing twice.
    const rows = machineSelector(stateFrom(hubFrames.machineStateWithServer), null).rows;
    expect(rows.map((row) => row.words)).toEqual(['unreachable']);
  });

  it('has no rows before the first state arrives', () => {
    expect(machineSelector(null, null).rows).toEqual([]);
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
    expect(machineSelector(populated, '').selected).toBeNull();
    expect(machineSelector(populated, null).selected).toBeNull();
  });
});

describe('the latency slot', () => {
  it('holds no number in this build', () => {
    // Nothing measures a round trip and `ServerView` has no field for one; the
    // protocol says only the end that dialled can time one, which is the hub.
    // This is where the figure lands when the heartbeat starts publishing it.
    expect(NO_LATENCY_MS).toBeNull();
    expect(machineSelector(populated, null).latencyMs).toBeNull();
  });
});
