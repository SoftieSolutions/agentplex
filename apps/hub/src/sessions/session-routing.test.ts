import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type ProviderReadiness,
  type ServerRegistrationId,
  type SessionDescriptor,
  type SessionHold,
  type SessionId,
  type StoreId,
} from '@agentplex/protocol';
import { missingProvider, readyProvider } from '@agentplex/providers/testing';
import { createLogger } from '@agentplex/node-shared';
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
  providers: readonly ProviderReadiness[] = [readyProvider()],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers,
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
    uncommitted: null,
  };
}

interface Machine {
  readonly label: string;
  readonly phase: ServerConnectionPhase;
  readonly stores: readonly StoreId[];
  /** What that machine's preflight found. A ready `claude` unless a test says otherwise. */
  readonly providers?: readonly ProviderReadiness[];
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
    reducer.applyConnection(
      connection(machine.label, machine.phase, machine.stores, machine.providers),
    );
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

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.server.label).toBe('workshop');
  });

  it('refuses a store no paired server has mounted', () => {
    const state = fleet([{ label: 'workshop', phase: 'connected', stores: [WORK] }]);

    const routed = routeStart(state, {
      storeId: SPARE,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed).toMatchObject({ ok: false, code: 'refused', holder: null });
  });

  it('refuses when every server with the store mounted is unreachable', () => {
    // Not a placement to retry elsewhere: there is nowhere else. The honest
    // answer is that nothing can run it now, with the machines still listed.
    const state = fleet([{ label: 'workshop', phase: 'stale', stores: [WORK] }]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

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

    const scheduled = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });
    expect(scheduled.ok && scheduled.server.label).toBe('attic');

    const overridden = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
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
      provider: 'claude',
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
      provider: 'claude',
      server: registration('attic'),
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('attic');
  });

  it('refuses a start when the machine does not have that provider installed', () => {
    // The case the whole preflight exists for. Without this the hub sends the
    // instruction, the server forks a pty successfully, the program fails to
    // resolve on the far side of it, and the user sees a session appear and
    // vanish with no output and nothing pointing at the cause.
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [missingProvider('claude')],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed).toMatchObject({ ok: false, code: 'refused', holder: null });
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    // The machine's own words, not a hub-invented summary: it names the box and
    // says what is wrong with it.
    expect(routed.problem).toContain('workshop');
    expect(routed.problem).toContain('claude');
  });

  it('refuses a start for a provider the machine never mentioned', () => {
    // A build with no adapter for it. Different from a missing binary, and a
    // different thing to fix, so it gets a different sentence.
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [readyProvider('claude')],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'codex',
      server: null,
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toBe('workshop does not run codex');
  });

  it('refuses a start for a provider the machine says is logged out', () => {
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [
          {
            provider: 'claude',
            state: 'unauthenticated',
            version: '9.9.9',
            directory: '/opt/bin',
            problem: 'claude is installed and logged out; run its login on that machine',
          },
        ],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('logged out');
  });

  it('starts anyway on a machine whose probes could not answer', () => {
    // The binary resolved; only the version could not be read. Refusing here
    // would turn "could not tell" into "no" and take a working machine out of
    // the fleet over a provider that renamed a subcommand.
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [
          {
            provider: 'claude',
            state: 'unknown',
            version: null,
            directory: '/opt/bin',
            problem: 'claude printed no version',
          },
        ],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });

  it('schedules onto the machine that has the provider, not the least loaded one', () => {
    // An unusable provider costs its own machine a start and never the store.
    // `attic` is idle and would win on load; it cannot run claude, so it does
    // not win at all, and the store stays perfectly startable.
    const state = fleet([
      {
        label: 'attic',
        phase: 'connected',
        stores: [WORK],
        providers: [missingProvider('claude')],
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

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });

  it('refuses an override naming a machine that cannot run the provider', () => {
    const state = fleet([
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [missingProvider('claude')],
      },
      { label: 'attic', phase: 'connected', stores: [WORK] },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: registration('workshop'),
    });

    // Not quietly rescheduled onto the machine that can. The user picked a box,
    // and answering by running it somewhere else would be the hub overriding a
    // choice rather than reporting on it.
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('workshop');
  });

  it('names every machine that refused when no machine on the store can run it', () => {
    const state = fleet([
      {
        label: 'attic',
        phase: 'connected',
        stores: [WORK],
        providers: [missingProvider('claude')],
      },
      {
        label: 'workshop',
        phase: 'connected',
        stores: [WORK],
        providers: [missingProvider('claude')],
      },
    ]);

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.problem).toContain('attic');
    expect(routed.problem).toContain('workshop');
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

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

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

    const routed = routeStart(state, {
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      server: null,
    });

    expect(routed.ok && routed.server.label).toBe('workshop');
  });

  it('breaks a tie the same way every time, rather than on map order', () => {
    const state = fleet([
      { label: 'workshop', phase: 'connected', stores: [WORK] },
      { label: 'attic', phase: 'connected', stores: [WORK] },
    ]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const routed = routeStart(state, {
        storeId: WORK,
        sessionId: null,
        provider: 'claude',
        server: null,
      });
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
      provider: 'claude',
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
      provider: 'claude',
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
      provider: 'claude',
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
