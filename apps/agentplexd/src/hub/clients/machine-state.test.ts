import { describe, expect, it } from 'vitest';
import {
  machineStateSchema,
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger } from '../../shared/logger.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
} from '../connections/server-connection.js';
import { serverAddressSchema } from '../pairing/server-address.js';
import { createReducer } from '../state/reducer.js';
import { toMachineState } from './machine-state.js';

/**
 * The projection, driven through the real reducer.
 *
 * The interesting questions are all about what does *not* come out: the address
 * the hub dials, the retry counter, and above all a second copy of a server
 * inlined under each store it has mounted.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});

function store(id: string): StoreId {
  return storeIdSchema.parse(id);
}

function registration(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly string[],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 4 : 0,
    problem: phase === 'stale' ? 'connection refused' : null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
  };
}

function session(id: string): SessionDescriptor {
  return {
    storeId: store('store-work'),
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status: 'awaiting-permission',
    updatedAt: START,
    cwd: '/srv/work',
    title: 'the ticket',
  };
}

/** Two servers with one volume mounted, one of them down, and a session on it. */
function published() {
  const state = createReducer({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applyConnection(connection('laptop', 'stale', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1')],
    reportedAt: START,
  });
  return toMachineState(state.snapshot());
}

describe('toMachineState', () => {
  it('produces something the wire parser accepts', () => {
    const parsed = machineStateSchema.safeParse(published());
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it('describes a server once and names it by id everywhere else', () => {
    const state = published();

    expect(state.servers.map((server) => server.registrationId)).toEqual([
      registration('laptop'),
      registration('workshop'),
    ]);
    // The store names its servers, it does not carry them. A frame that carried
    // them twice could say `connected` in one place and `stale` in the other.
    expect(state.stores[0]?.servers).toEqual([registration('laptop'), registration('workshop')]);
  });

  it('does not publish the address the hub dials, nor its retry bookkeeping', () => {
    const [server] = published().servers;
    expect(server).toBeDefined();
    expect(server).not.toHaveProperty('address');
    expect(server).not.toHaveProperty('failedAttempts');
  });

  it('keeps a stale server, its reason and its age, rather than dropping the row', () => {
    const laptop = published().servers.find((server) => server.label === 'laptop');
    expect(laptop).toMatchObject({
      phase: 'stale',
      staleReason: 'unreachable',
      staleSince: START + 1_000,
      lastConnectedAt: START,
      problem: 'connection refused',
      stores: [store('store-work')],
    });
  });

  it('carries the session descriptor whole, with who saw it beside it', () => {
    const [row] = published().stores[0]?.sessions ?? [];
    expect(row?.descriptor).toEqual(session('session-1'));
    expect(row?.source).toBe(registration('workshop'));
    expect(row?.reportedBy).toEqual([registration('workshop')]);
    // The reducer's `ref` is not restated: it is the descriptor's own two
    // fields, and two fields on a wire that must agree can disagree.
    expect(row).not.toHaveProperty('ref');
  });

  it('publishes the empty state a hub with no pairings has', () => {
    const state = toMachineState(createReducer({ logger }).snapshot());
    expect(state).toEqual({ version: 0, stores: [], servers: [] });
    expect(machineStateSchema.safeParse(state).success).toBe(true);
  });
});
