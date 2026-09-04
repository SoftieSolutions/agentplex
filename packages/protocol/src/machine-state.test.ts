import { describe, expect, it } from 'vitest';
import {
  machineStateSchema,
  serverCandidateSchema,
  serverViewSchema,
  sessionRowSchema,
} from './machine-state.js';

/**
 * Fixtures here are hand-written, and the exception is the point: these are
 * claims about what the wire accepts, not captured output of anything. The
 * captured-output rule is about what a parser is fed from a real system; the
 * subject here is the parser itself, and a fixture recorded from the hub could
 * only ever agree with the hub.
 */
const A_SERVER = {
  registrationId: 'registration-1',
  label: 'workshop',
  serverId: 'server-1',
  phase: 'connected',
  stores: ['store-work'],
  connectedSince: 1_000,
  staleSince: null,
  lastConnectedAt: 1_000,
  staleReason: null,
  problem: null,
};

const A_CANDIDATE = {
  serverId: 'server-1',
  address: '192.168.1.24',
  port: 8443,
  protocolVersion: 5,
};

const A_SESSION_ROW = {
  descriptor: {
    storeId: 'store-work',
    sessionId: 'session-1',
    provider: 'claude',
    status: 'idle',
    updatedAt: 900,
    cwd: '/srv/work',
    title: null,
  },
  source: 'registration-1',
  reportedBy: ['registration-1'],
  reportedAt: 1_000,
  reachable: true,
  holder: null,
};

describe('serverViewSchema', () => {
  it('accepts a connected server', () => {
    expect(serverViewSchema.safeParse(A_SERVER).success).toBe(true);
  });

  it('accepts a server that has never handshaken, with no serverId', () => {
    expect(
      serverViewSchema.safeParse({
        ...A_SERVER,
        serverId: null,
        phase: 'connecting',
        connectedSince: null,
        lastConnectedAt: null,
      }).success,
    ).toBe(true);
  });

  it('accepts every stale reason the supervisor can produce', () => {
    for (const staleReason of [
      'unreachable',
      'timeout',
      'unauthorized',
      'protocol-version',
      'protocol-error',
      'closed',
      'dropped',
      'identity-changed',
      'hub-error',
    ]) {
      const parsed = serverViewSchema.safeParse({
        ...A_SERVER,
        phase: 'stale',
        staleReason,
        staleSince: 2_000,
        problem: 'the connection to the server ended',
      });
      expect(parsed.success, staleReason).toBe(true);
    }
  });

  it('rejects a stale reason nothing produces, rather than passing the word along', () => {
    expect(serverViewSchema.safeParse({ ...A_SERVER, staleReason: 'grumpy' }).success).toBe(false);
  });
});

describe('sessionRowSchema', () => {
  it('accepts a row reported by two servers on one volume', () => {
    expect(
      sessionRowSchema.safeParse({
        ...A_SESSION_ROW,
        reportedBy: ['registration-1', 'registration-2'],
      }).success,
    ).toBe(true);
  });

  it('rejects a row nobody reported: a session with no source is not a reading', () => {
    expect(sessionRowSchema.safeParse({ ...A_SESSION_ROW, reportedBy: [] }).success).toBe(false);
  });

  it('accepts a row held by a server, with whether it may be stopped', () => {
    const parsed = sessionRowSchema.safeParse({
      ...A_SESSION_ROW,
      holder: { server: 'registration-1', stoppable: false },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a holder that inlines a server object where an id belongs', () => {
    const parsed = sessionRowSchema.safeParse({
      ...A_SESSION_ROW,
      holder: { server: A_SERVER, stoppable: true },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a holder with no answer about stopping, rather than assuming one', () => {
    const parsed = sessionRowSchema.safeParse({
      ...A_SESSION_ROW,
      holder: { server: 'registration-1' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a row with no holder field: a missing holder is not the same as none', () => {
    const { holder, ...withoutHolder } = A_SESSION_ROW;
    expect(holder).toBeNull();
    expect(sessionRowSchema.safeParse(withoutHolder).success).toBe(false);
  });
});

describe('serverCandidateSchema', () => {
  it('accepts a machine heard announcing itself', () => {
    expect(serverCandidateSchema.safeParse(A_CANDIDATE).success).toBe(true);
  });

  it('accepts one claiming a protocol this build does not speak', () => {
    // Kept rather than dropped: a hub that refused to publish a mismatched
    // beacon could only report silence, where what it can report is a machine
    // it can see and cannot speak to.
    expect(serverCandidateSchema.safeParse({ ...A_CANDIDATE, protocolVersion: 1 }).success).toBe(
      true,
    );
  });

  it('rejects a candidate carrying a token, whatever the sender called the field', () => {
    // The rule the beacon schema enforces on the wire in, restated on the wire
    // out: there is nowhere here to put a secret, so a hub cannot forward one
    // it was somehow sent.
    const parsed = serverCandidateSchema.safeParse({ ...A_CANDIDATE, token: 'not-a-chance' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data).sort()).toEqual([
      'address',
      'port',
      'protocolVersion',
      'serverId',
    ]);
  });

  it('rejects a candidate with no port: an address alone is not somewhere to dial', () => {
    const { port, ...withoutPort } = A_CANDIDATE;
    expect(port).toBe(8443);
    expect(serverCandidateSchema.safeParse(withoutPort).success).toBe(false);
  });

  it('rejects a registrationId on a candidate, which is what a pairing has', () => {
    // The structural half of "a candidate is not a peer": nothing here can be
    // mistaken for a row in `servers`, because a candidate has no key that a
    // paired server is addressed by.
    expect(serverCandidateSchema.safeParse(A_CANDIDATE).success).toBe(true);
    expect(serverViewSchema.safeParse(A_CANDIDATE).success).toBe(false);
  });
});

describe('machineStateSchema', () => {
  it('accepts the empty state a hub with no pairings publishes', () => {
    expect(
      machineStateSchema.safeParse({ version: 0, stores: [], servers: [], candidates: [] }).success,
    ).toBe(true);
  });

  it('rejects a state with no candidates field: heard-nothing is a list, not an absence', () => {
    // A hub always has an answer to "what have you heard on the network" —
    // usually the empty one. An optional field would let a client that saw no
    // property and a client that saw an empty list draw different screens off
    // the same fact.
    expect(machineStateSchema.safeParse({ version: 0, stores: [], servers: [] }).success).toBe(
      false,
    );
  });

  it('keeps candidates out of the paired-server list entirely', () => {
    const parsed = machineStateSchema.safeParse({
      version: 7,
      stores: [],
      servers: [A_SERVER],
      candidates: [A_CANDIDATE],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.servers).toHaveLength(1);
    expect(parsed.data.candidates).toHaveLength(1);
    // The two collections are separate types as well as separate fields: a
    // candidate is not admissible where a paired server goes.
    expect(
      machineStateSchema.safeParse({
        version: 7,
        stores: [],
        servers: [A_CANDIDATE],
        candidates: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a store that names its servers by id', () => {
    const parsed = machineStateSchema.safeParse({
      version: 4,
      servers: [A_SERVER],
      candidates: [],
      stores: [
        {
          storeId: 'store-work',
          servers: ['registration-1'],
          reachable: true,
          unreachableSince: null,
          lastReachableAt: 1_000,
          sessions: [A_SESSION_ROW],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a store that inlines a server object where an id belongs', () => {
    const parsed = machineStateSchema.safeParse({
      version: 4,
      servers: [A_SERVER],
      candidates: [],
      stores: [
        {
          storeId: 'store-work',
          servers: [A_SERVER],
          reachable: true,
          unreachableSince: null,
          lastReachableAt: 1_000,
          sessions: [],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative version', () => {
    expect(
      machineStateSchema.safeParse({ version: -1, stores: [], servers: [], candidates: [] })
        .success,
    ).toBe(false);
  });
});
