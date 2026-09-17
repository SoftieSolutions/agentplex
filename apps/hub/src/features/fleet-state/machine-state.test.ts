import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  machineStateSchema,
  serverIdSchema,
  serverAddressSchema,
  sessionIdSchema,
  storeIdSchema,
  type MachineState,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createLogger } from '@agentplex/node-shared';
import type { ServerConnectionPhase, ServerConnectionReport } from '../servers/servers.js';
import { createFleetState } from '../fleet-state/fleet-state.js';
import { toMachineState } from './machine-state.js';

/**
 * The projection, driven through the real reducer.
 *
 * The interesting questions are mostly about what does *not* come out: the
 * retry counter, a candidate's aging timestamp, and above all a second copy of
 * a server inlined under each store it has mounted. The address is the one that
 * used to be on that list and is not: a client that can unpair is drawing the
 * pairing screen, and a row it can destroy has to say which machine it is.
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
    providers: [readyProvider()],
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 4 : 0,
    problem: phase === 'stale' ? 'connection refused' : null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    draining: null,
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
    branch: null,
    title: 'the ticket',
    uncommitted: null,
  };
}

/** Two servers with one volume mounted, one of them down, and a session on it. */
function published(attention?: { acknowledgedAt: number | null; mutedAt: number | null }) {
  const state = createFleetState({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applyConnection(connection('laptop', 'stale', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1')],
    reportedAt: START,
  });
  if (attention !== undefined) {
    state.applyAttention(
      { storeId: store('store-work'), sessionId: sessionIdSchema.parse('session-1') },
      attention,
    );
  }
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

  it('publishes the address the hub dials, which is the row the settings screen draws', () => {
    const laptop = published().servers.find((server) => server.label === 'laptop');
    expect(laptop?.address).toBe('wss://laptop.example:8443');
  });

  it('does not publish the retry bookkeeping: a number nobody can act on', () => {
    const [server] = published().servers;
    expect(server).toBeDefined();
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

  it('flattens the two attention moments onto the row, beside the descriptor', () => {
    const [row] =
      published({ acknowledgedAt: START + 5, mutedAt: START + 9 })?.stores[0]?.sessions ?? [];
    expect(row?.acknowledgedAt).toBe(START + 5);
    expect(row?.mutedAt).toBe(START + 9);
    // Flat and not nested: the comparison a client makes is against
    // `descriptor.updatedAt` on the same row, and a `null` object in the way
    // of it would be a branch on the common case of a session nobody has said
    // anything about.
    expect(row).not.toHaveProperty('attention');
  });

  it('publishes nulls for a session nobody has spoken about, rather than leaving the fields out', () => {
    const [row] = published().stores[0]?.sessions ?? [];
    expect(row).toMatchObject({ acknowledgedAt: null, mutedAt: null });
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

  it('publishes each provider whole, version and directory included', () => {
    // Not reduced to "ready". Which directory a provider came from is the
    // question an operator asks when the wrong version runs, and the hub is the
    // only thing that was ever told the answer.
    const [server] = published().servers;

    expect(server?.providers).toEqual([
      {
        provider: 'claude',
        state: 'ready',
        version: '9.9.9',
        directory: '/home/robert/.agentplex/bin',
        problem: null,
      },
    ]);
  });

  it('publishes the empty state a hub with no pairings has', () => {
    const state = toMachineState(createFleetState({ logger }).snapshot());
    expect(state).toEqual({ version: 0, stores: [], servers: [], candidates: [] });
    expect(machineStateSchema.safeParse(state).success).toBe(true);
  });
});

describe('candidates on the wire', () => {
  function heard(): MachineState {
    const state = createFleetState({ logger });
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applyCandidates([
      {
        serverId: serverIdSchema.parse('server-heard'),
        address: '192.168.1.24',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION,
        heardAt: START,
        heardFrom: '192.168.1.24',
      },
    ]);
    return toMachineState(state.snapshot());
  }

  it('publishes what was heard as a candidate and never as a server', () => {
    const state = heard();
    expect(state.candidates.map((candidate) => candidate.serverId)).toEqual(['server-heard']);
    expect(state.servers.map((server) => server.registrationId)).toEqual([
      registration('workshop'),
    ]);
    expect(machineStateSchema.safeParse(state).success).toBe(true);
  });

  it('drops when it was heard and where the datagram came from', () => {
    // Both are the hub's own bookkeeping. The age is what the aging is done
    // against, and publishing it would put a field that moves every five
    // seconds into a frame that goes whole to every client; the source address
    // is a cross-check an operator reads in a log, and a client shown two
    // addresses has been handed a decision the hub could not make either.
    const candidate = heard().candidates[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(Object.keys(candidate).sort()).toEqual([
      'address',
      'port',
      'protocolVersion',
      'serverId',
    ]);
  });

  it('carries the claimed protocol version rather than a verdict about it', () => {
    const state = createFleetState({ logger });
    state.applyCandidates([
      {
        serverId: serverIdSchema.parse('server-old'),
        address: '192.168.1.9',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION - 1,
        heardAt: START,
        heardFrom: '192.168.1.9',
      },
    ]);
    const published = toMachineState(state.snapshot());
    expect(published.candidates[0]?.protocolVersion).toBe(PROTOCOL_VERSION - 1);
  });

  it('publishes an empty list for a hub that has heard nothing', () => {
    // Not an absent field: "I have heard nothing" is an answer, and a client
    // must not have to tell it apart from a hub too old to have listened.
    expect(toMachineState(createFleetState({ logger }).snapshot()).candidates).toEqual([]);
  });
});
