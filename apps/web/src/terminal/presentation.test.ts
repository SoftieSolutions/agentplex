import { describe, expect, it } from 'vitest';
import {
  machineStateSchema,
  sessionRefSchema,
  sessionStatusSchema,
  type MachineState,
} from '@agentplex/protocol';
import type { HubSnapshot } from '../store/hub-store.js';
import { EMULATOR_SCROLLBACK_LINES } from './emulator.js';
import {
  findSessionRow,
  machineLabel,
  matchSummary,
  searchScopeNotice,
  terminalInputNotice,
  toneForStatus,
} from './presentation.js';

/**
 * Values here are built through the protocol's own parsers — the same door
 * wire data comes through — so a schema change fails these tests instead of
 * letting a hand-shaped object drift from the real frames.
 */

const ref = sessionRefSchema.parse({ storeId: 'store-a', sessionId: 'sess-1' });

function stateWith(overrides?: {
  holder?: { server: string; stoppable: boolean } | null;
}): MachineState {
  return machineStateSchema.parse({
    version: 3,
    stores: [
      {
        storeId: 'store-a',
        servers: ['reg-1'],
        reachable: true,
        unreachableSince: null,
        lastReachableAt: 1_756_000_000_000,
        sessions: [
          {
            descriptor: {
              storeId: 'store-a',
              sessionId: 'sess-1',
              provider: 'claude',
              status: 'working',
              updatedAt: 1_756_000_000_000,
              cwd: '/home/robert/code/universe',
              branch: null,
              title: 'fix-auth-refresh',
              uncommitted: null,
            },
            source: 'reg-1',
            reportedBy: ['reg-1'],
            reportedAt: 1_756_000_000_000,
            reachable: true,
            holder:
              overrides?.holder === undefined
                ? { server: 'reg-1', stoppable: true }
                : overrides.holder,
          },
        ],
      },
    ],
    servers: [
      {
        registrationId: 'reg-1',
        label: 'mbp-robert',
        address: 'wss://mbp-robert.example:8443',
        serverId: 'srv-1',
        phase: 'connected',
        stores: ['store-a'],
        // What that machine can start. This file is about drawing sessions, so
        // it is the ordinary case: the provider these sessions run under is
        // installed and logged in.
        providers: [
          {
            provider: 'claude',
            state: 'ready',
            version: '2.1.259',
            directory: '/home/robert/.local/bin',
            problem: null,
          },
        ],
        connectedSince: 1_756_000_000_000,
        staleSince: null,
        lastConnectedAt: 1_756_000_000_000,
        staleReason: null,
        // Not going anywhere: this file is about drawing sessions on a machine
        // that is answering, and a drain is the settings screen's subject.
        draining: null,
        problem: null,
      },
    ],
    // Nothing heard on the network: this file is about drawing sessions, and
    // a candidate is neither a session nor a machine any of them run on.
    candidates: [],
  });
}

function snapshotWith(overrides: Partial<HubSnapshot>): HubSnapshot {
  return {
    phase: 'connected',
    problem: null,
    hubId: null,
    machineState: null,
    layout: null,
    paneLayout: null,
    commandQueue: { queued: 0, capacity: 32, overflowed: null },
    terminalInput: { discarded: 0, notice: null },
    lastRefusal: null,
    lastStarted: null,
    lastStopped: null,
    lastListing: null,
    lastProjectCreated: null,
    ...overrides,
  };
}

describe('toneForStatus', () => {
  it('maps every status the wire can carry, both awaiting states loudly', () => {
    const tones = Object.fromEntries(
      sessionStatusSchema.options.map((status) => [status, toneForStatus(status)]),
    );
    expect(tones).toEqual({
      working: 'running',
      'awaiting-permission': 'needs-you',
      'awaiting-input': 'needs-you',
      idle: 'idle',
      unknown: 'idle',
    });
  });
});

describe('findSessionRow', () => {
  it('finds the routed session', () => {
    const row = findSessionRow(stateWith(), ref);
    expect(row?.descriptor.title).toBe('fix-auth-refresh');
  });

  it('answers null before any state arrived, and for a session the hub does not know', () => {
    expect(findSessionRow(null, ref)).toBeNull();
    const other = sessionRefSchema.parse({ storeId: 'store-a', sessionId: 'sess-9' });
    expect(findSessionRow(stateWith(), other)).toBeNull();
  });
});

describe('machineLabel', () => {
  it('names the holder while somebody runs the session', () => {
    const state = stateWith();
    const row = findSessionRow(state, ref);
    if (row === null) throw new Error('the fixture lost its row');
    expect(machineLabel(state, row)).toBe('mbp-robert');
  });

  it('falls back to the reporting server for an unheld session', () => {
    const state = stateWith({ holder: null });
    const row = findSessionRow(state, ref);
    if (row === null) throw new Error('the fixture lost its row');
    expect(machineLabel(state, row)).toBe('mbp-robert');
  });
});

describe('terminalInputNotice', () => {
  it('says nothing while typing is going somewhere', () => {
    expect(terminalInputNotice(snapshotWith({}), null)).toBeNull();
  });

  it('repeats the store notice while the connection is down: discarded, in words', () => {
    const notice =
      'the connection is down: 3 keystrokes were discarded, not queued — nothing typed here will replay when it returns';
    const snapshot = snapshotWith({
      phase: 'reconnecting',
      terminalInput: { discarded: 3, notice },
    });
    expect(terminalInputNotice(snapshot, 'anything')).toBe(notice);
  });

  it('says why a live connection refused a keystroke, which today is the missing frame', () => {
    const refused = terminalInputNotice(
      snapshotWith({}),
      'this build cannot send terminal input yet',
    );
    expect(refused).toBe('typing goes nowhere: this build cannot send terminal input yet');
  });

  it('does not carry a stale refusal into a reconnecting spell the store already words', () => {
    const snapshot = snapshotWith({ phase: 'reconnecting' });
    expect(terminalInputNotice(snapshot, 'stale reason')).toBeNull();
  });
});

describe('matchSummary', () => {
  it('says nothing before anything has been typed', () => {
    expect(matchSummary('', { index: 4, count: 9 })).toBe('');
    expect(matchSummary('refresh', null)).toBe('');
  });

  it('counts from one, because the user is not counting from zero', () => {
    expect(matchSummary('refresh', { index: 2, count: 12 })).toBe('3 of 12');
    expect(matchSummary('refresh', { index: 0, count: 1 })).toBe('1 of 1');
  });

  it('gives a total without a position when it is standing on no match', () => {
    expect(matchSummary('refresh', { index: -1, count: 12 })).toBe('12 matches');
    expect(matchSummary('refresh', { index: -1, count: 1 })).toBe('1 match');
  });

  it('says a miss is a miss rather than showing an empty count', () => {
    expect(matchSummary('refresh', { index: -1, count: 0 })).toBe('no matches');
  });
});

describe('searchScopeNotice', () => {
  it('says nothing while the pane still holds everything it was sent', () => {
    expect(searchScopeNotice(false)).toBeNull();
  });

  it('names the window and refuses to let a miss stand for absence', () => {
    const notice = searchScopeNotice(true);
    expect(notice).toContain(String(EMULATOR_SCROLLBACK_LINES));
    expect(notice).toContain('not proof of absence');
  });
});
