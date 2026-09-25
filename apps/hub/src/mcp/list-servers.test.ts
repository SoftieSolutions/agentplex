import {
  serverAddressSchema,
  serverIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type MachineState,
  type ServerView,
} from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { listServersTool } from './list-servers.js';
import { callTool } from './test-tool-call.js';

/**
 * `list_servers`, against a fleet state that is a value.
 *
 * The seam is `published()`, so a suite supplies the published state directly
 * rather than standing a reducer up and feeding it reports. What is under test
 * is the projection -- which fields an agent is handed, and that an unreachable
 * machine keeps what it reported -- and a reducer in the way would be asking
 * the reducer's own suite its questions again.
 */

const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const WORKSHOP = serverRegistrationIdSchema.parse('registration-workshop');
const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');

function machine(
  overrides: Partial<ServerView> & Pick<ServerView, 'registrationId' | 'label'>,
): ServerView {
  return {
    address: serverAddressSchema.parse('wss://machine.example:8443'),
    serverId: serverIdSchema.parse('server-1'),
    phase: 'connected',
    stores: [WORK],
    providers: [],
    connectedSince: 1_756_000_000_000,
    staleSince: null,
    lastConnectedAt: 1_756_000_000_000,
    staleReason: null,
    draining: null,
    problem: null,
    ...overrides,
  };
}

function fleetOf(servers: readonly ServerView[]): MachineState {
  return { version: 7, stores: [], servers: [...servers], candidates: [], graphRunApprovals: [] };
}

function listing(state: MachineState): ReturnType<typeof callTool> {
  return callTool(listServersTool({ state: { published: () => state } }));
}

describe('list_servers', () => {
  it('answers with the pairings, by the id everything else names a machine by', async () => {
    const result = await listing(
      fleetOf([
        machine({ registrationId: ATTIC, label: 'attic' }),
        machine({ registrationId: WORKSHOP, label: 'workshop' }),
      ]),
    );

    expect(result.structured).toEqual({
      servers: [
        {
          registrationId: ATTIC,
          label: 'attic',
          phase: 'connected',
          staleReason: null,
          draining: null,
          problem: null,
          stores: [WORK],
          providers: [],
        },
        {
          registrationId: WORKSHOP,
          label: 'workshop',
          phase: 'connected',
          staleReason: null,
          draining: null,
          problem: null,
          stores: [WORK],
          providers: [],
        },
      ],
    });
  });

  it('carries each provider with its readiness, which is what a start is refused on', async () => {
    const result = await listing(
      fleetOf([
        machine({
          registrationId: ATTIC,
          label: 'attic',
          providers: [
            {
              provider: 'claude',
              state: 'ready',
              version: '2.1.0',
              directory: '/usr/local/bin',
              problem: null,
            },
            {
              provider: 'codex',
              state: 'missing',
              version: null,
              directory: null,
              problem: 'codex is not installed on attic',
            },
          ],
        }),
      ]),
    );

    const answered = result.structured as { servers: { providers: unknown[] }[] };
    // The sentence travels. "That box has no codex" is what an operator needs
    // before a start is refused, not after it.
    expect(answered.servers[0]?.providers).toEqual([
      {
        provider: 'claude',
        state: 'ready',
        version: '2.1.0',
        directory: '/usr/local/bin',
        problem: null,
      },
      {
        provider: 'codex',
        state: 'missing',
        version: null,
        directory: null,
        problem: 'codex is not installed on attic',
      },
    ]);
  });

  it('keeps what an unreachable machine reported, with the reason it cannot be asked', async () => {
    const result = await listing(
      fleetOf([
        machine({
          registrationId: ATTIC,
          label: 'attic',
          phase: 'stale',
          staleReason: 'unreachable',
          problem: 'attic did not answer',
          connectedSince: null,
          staleSince: 1_756_000_100_000,
          providers: [
            {
              provider: 'claude',
              state: 'ready',
              version: '2.1.0',
              directory: '/usr/bin',
              problem: null,
            },
          ],
        }),
      ]),
    );

    const answered = result.structured as {
      servers: { staleReason: string; problem: string; stores: string[]; providers: unknown[] }[];
    };
    // The rows stay. A machine that is asleep reading as a machine with nothing
    // mounted is the over-claim the stale label exists to prevent.
    expect(answered.servers[0]?.stores).toEqual([WORK]);
    expect(answered.servers[0]?.providers).toHaveLength(1);
    // A word to branch on and a sentence to show. Different jobs, both carried.
    expect(answered.servers[0]?.staleReason).toBe('unreachable');
    expect(answered.servers[0]?.problem).toBe('attic did not answer');
  });

  it('hands an agent nothing the hub dials with', async () => {
    // The seam is `published()`, so the dialled address and the retry counter
    // are not reachable from this tool at all. This asserts the other half:
    // that the shape an agent is handed has no room for them either.
    const result = await listing(fleetOf([machine({ registrationId: ATTIC, label: 'attic' })]));

    const answered = result.structured as { servers: Record<string, unknown>[] };
    expect(Object.keys(answered.servers[0] ?? {}).sort()).toEqual([
      'draining',
      'label',
      'phase',
      'problem',
      'providers',
      'registrationId',
      'staleReason',
      'stores',
    ]);
  });

  it('says a machine is going away while it is still answering', async () => {
    // The pair a client draws as "shutting down, N sessions finishing", and the
    // reason `draining` is published beside the phase rather than folded into
    // it: the connection is genuinely up, so a row read on `phase` alone looks
    // like somewhere to start work.
    const result = await listing(
      fleetOf([
        machine({
          registrationId: ATTIC,
          label: 'attic',
          phase: 'connected',
          draining: {
            since: 1_756_000_000_500,
            graceMs: 30_000,
            sessions: [{ storeId: WORK, sessionId: QUIET }],
          },
        }),
      ]),
    );

    const answered = result.structured as { servers: { draining: unknown; phase: string }[] };
    expect(answered.servers[0]?.phase).toBe('connected');
    expect(answered.servers[0]?.draining).toEqual({
      since: 1_756_000_000_500,
      graceMs: 30_000,
      sessions: [{ storeId: WORK, sessionId: QUIET }],
    });
  });

  it('keeps the announcement after the machine has gone, beside the reason it went', async () => {
    // The last thing the machine actually said, with its age attached, rather
    // than a row that empties out and reads as a machine that simply went.
    const result = await listing(
      fleetOf([
        machine({
          registrationId: ATTIC,
          label: 'attic',
          phase: 'stale',
          staleReason: 'draining',
          problem: 'attic said it was shutting down',
          draining: { since: 1_756_000_000_500, graceMs: 30_000, sessions: [] },
        }),
      ]),
    );

    const answered = result.structured as { servers: { staleReason: string; draining: unknown }[] };
    expect(answered.servers[0]?.staleReason).toBe('draining');
    expect(answered.servers[0]?.draining).toEqual({
      since: 1_756_000_000_500,
      graceMs: 30_000,
      sessions: [],
    });
  });

  it('says it only reads, in the field a client checks before it asks a person', async () => {
    const tool = listServersTool({ state: { published: () => fleetOf([]) } });

    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});
