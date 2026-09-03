import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionDescriptor,
  type SessionHold,
  type SessionId,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger } from '../../shared/logger.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
} from '../connections/server-connection.js';
import { serverAddressSchema } from '../pairing/server-address.js';
import { createReducer, type HubStateSnapshot } from '../state/reducer.js';
import { routeStart, routeStop } from './session-routing.js';

/**
 * The scheduling decision, against real reduced state.
 *
 * The state is built by driving the reducer rather than by writing a snapshot
 * literal, and that is deliberate: what a hub actually holds is what its
 * servers reported, and a hand-written snapshot could describe a store no
 * sequence of reports could produce -- a holder on a machine that never said it
 * was holding anything, or a session in a store nobody has mounted.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});

const WORK = storeIdSchema.parse('store-work');
const SPARE = storeIdSchema.parse('store-spare');

function registration(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

function sessionId(id: string): SessionId {
  return sessionIdSchema.parse(id);
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly StoreId[],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    stores,
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
  };
}

function session(id: string, storeId: StoreId = WORK): SessionDescriptor {
  return {
    storeId,
    sessionId: sessionId(id),
    provider: 'claude',
    status: 'idle',
    updatedAt: START,
    cwd: '/srv/work',
    title: null,
  };
}

interface Machine {
  readonly label: string;
  readonly phase: ServerConnectionPhase;
  readonly stores: readonly StoreId[];
  /** What that machine reports per store: the sessions it sees and what it holds. */
  readonly reports?: readonly {
    readonly storeId: StoreId;
    readonly sessions: readonly SessionDescriptor[];
    readonly holding?: readonly SessionHold[];
  }[];
}

function fleet(machines: readonly Machine[]): HubStateSnapshot {
  const reducer = createReducer({ logger });
  for (const machine of machines) {
    reducer.applyConnection(connection(machine.label, machine.phase, machine.stores));
  }
  for (const machine of machines) {
    for (const report of machine.reports ?? []) {
      reducer.applySessions({
        registrationId: registration(machine.label),
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding ?? [],
        reportedAt: START,
      });
    }
  }
  return reducer.snapshot();
}

describe('routeStart', () => {
  it('sends a start to the one live server attached to the store', () => {
    const state = fleet([{ label: 'workshop', phase: 'connected', stores: [WORK] }]);

    const routed = routeStart(state, { storeId: WORK, sessionId: null, server: null });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.server.label).toBe('workshop');
  });

  it('refuses a store no paired server has mounted', () => {
    const state = fleet([{ label: 'workshop', phase: 'connected', stores: [WORK] }]);

    const routed = routeStart(state, { storeId: SPARE, sessionId: null, server: null });

    expect(routed).toMatchObject({ ok: false, code: 'refused', holder: null });
  });

  it('refuses when every server with the store mounted is unreachable', () => {
    // Not a placement to retry elsewhere: there is nowhere else. The honest
    // answer is that nothing can run it now, with the machines still listed.
    const state = fleet([{ label: 'workshop', phase: 'stale', stores: [WORK] }]);

    const routed = routeStart(state, { storeId: WORK, sessionId: null, server: null });

    expect(routed).toMatchObject({ ok: false, code: 'refused' });
  });

  it('honours the machine the user chose over the one it would have picked', () => {
    // `attic` is the least loaded, so the scheduler would take it. An override
    // that the scheduler agreed with would prove nothing.
    const state = fleet([
      {
        label: 'attic',
        phase: 'connected',
        stores: [WORK],
        reports: [{ storeId: WORK, sessions: [] }],
      },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [
          {
            storeId: WORK,
            sessions: [session('session-1')],
            holding: [{ sessionId: sessionId('session-1'), stoppable: true }],
          },
        ],
      },
    ]);

    const scheduled = routeStart(state, { storeId: WORK, sessionId: null, server: null });
    expect(scheduled.ok && scheduled.server.label).toBe('attic');

    const overridden = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      server: registration('workshop'),
    });
    expect(overridden.ok && overridden.server.label).toBe('workshop');
  });

  it('refuses an override naming a server without that store mounted', () => {
    const state = fleet([
      { label: 'workshop', phase: 'connected', stores: [WORK] },
      { label: 'attic', phase: 'connected', stores: [SPARE] },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      server: registration('attic'),
    });

    expect(routed).toMatchObject({ ok: false, code: 'refused', holder: null });
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('does not have that store mounted');
  });

  it('refuses an override naming a machine the hub cannot reach, and says which', () => {
    const state = fleet([
      { label: 'workshop', phase: 'connected', stores: [WORK] },
      { label: 'attic', phase: 'stale', stores: [WORK] },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      server: registration('attic'),
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('attic');
  });

  it('picks the machine running the fewest agents, not the one with fewest sessions', () => {
    // Both servers have the same volume mounted and therefore see the same
    // transcripts. Only what each is running tells them apart.
    const sessions = [session('session-1'), session('session-2'), session('session-3')];
    const state = fleet([
      {
        label: 'attic',
        phase: 'connected',
        stores: [WORK],
        reports: [
          {
            storeId: WORK,
            sessions,
            holding: [
              { sessionId: sessionId('session-1'), stoppable: true },
              { sessionId: sessionId('session-2'), stoppable: true },
            ],
          },
        ],
      },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [{ storeId: WORK, sessions }],
      },
    ]);

    const routed = routeStart(state, { storeId: WORK, sessionId: null, server: null });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });

  it('counts a machine load across every store it has mounted', () => {
    // The busy machine is busy in another store entirely. A scheduler that
    // counted only this store's sessions would send the work to the machine
    // already running everything.
    const state = fleet([
      {
        label: 'attic',
        phase: 'connected',
        stores: [WORK, SPARE],
        reports: [
          { storeId: WORK, sessions: [] },
          {
            storeId: SPARE,
            sessions: [session('session-9', SPARE)],
            holding: [{ sessionId: sessionId('session-9'), stoppable: true }],
          },
        ],
      },
      { label: 'workshop', phase: 'connected', stores: [WORK] },
    ]);

    const routed = routeStart(state, { storeId: WORK, sessionId: null, server: null });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });

  it('breaks a tie the same way every time, rather than on map order', () => {
    const state = fleet([
      { label: 'workshop', phase: 'connected', stores: [WORK] },
      { label: 'attic', phase: 'connected', stores: [WORK] },
    ]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const routed = routeStart(state, { storeId: WORK, sessionId: null, server: null });
      expect(routed.ok && routed.server.label).toBe('attic');
    }
  });

  it('refuses a session that is already running, and names the machine holding it', () => {
    const state = fleet([
      { label: 'attic', phase: 'connected', stores: [WORK] },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [
          {
            storeId: WORK,
            sessions: [session('session-1')],
            holding: [{ sessionId: sessionId('session-1'), stoppable: true }],
          },
        ],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: sessionId('session-1'),
      server: null,
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.holder).toEqual({ server: registration('workshop'), stoppable: true });
    expect(routed.problem).toContain('workshop');
  });

  it('refuses a held session even when the user picked a free machine for it', () => {
    // The whole point of enforcing this at the hub: the second machine has the
    // volume mounted and nothing running, and starting there would put two
    // agents on one transcript.
    const state = fleet([
      { label: 'attic', phase: 'connected', stores: [WORK] },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [
          {
            storeId: WORK,
            sessions: [session('session-1')],
            holding: [{ sessionId: sessionId('session-1'), stoppable: false }],
          },
        ],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: sessionId('session-1'),
      server: registration('attic'),
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.holder).toEqual({ server: registration('workshop'), stoppable: false });
  });

  it('lets a session nobody is running be resumed', () => {
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [{ storeId: WORK, sessions: [session('session-1')] }],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: sessionId('session-1'),
      server: null,
    });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });
});

describe('routeStop', () => {
  const held = (stoppable: boolean): HubStateSnapshot =>
    fleet([
      { label: 'attic', phase: 'connected', stores: [WORK] },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [
          {
            storeId: WORK,
            sessions: [session('session-1')],
            holding: [{ sessionId: sessionId('session-1'), stoppable }],
          },
        ],
      },
    ]);

  it('resolves the owner from the session alone', () => {
    const routed = routeStop(held(true), { storeId: WORK, sessionId: sessionId('session-1') });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.server.label).toBe('workshop');
  });

  it('refuses to stop a session that is mid-turn, and names the holder anyway', () => {
    const routed = routeStop(held(false), { storeId: WORK, sessionId: sessionId('session-1') });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.holder).toEqual({ server: registration('workshop'), stoppable: false });
  });

  it('refuses to stop a session nothing is running', () => {
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        reports: [{ storeId: WORK, sessions: [session('session-1')] }],
      },
    ]);

    const routed = routeStop(state, { storeId: WORK, sessionId: sessionId('session-1') });

    expect(routed).toMatchObject({ ok: false, code: 'refused', holder: null });
  });

  it('refuses to stop a session in a store the hub knows nothing about', () => {
    const state = fleet([{ label: 'workshop', phase: 'connected', stores: [WORK] }]);

    const routed = routeStop(state, { storeId: SPARE, sessionId: sessionId('session-1') });

    expect(routed).toMatchObject({ ok: false, code: 'refused' });
  });
});
