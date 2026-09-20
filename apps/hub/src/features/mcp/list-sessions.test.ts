import {
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type MachineState,
  type SessionDescriptor,
  type SessionRow,
  type StoreView,
} from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { listSessionsTool, LIST_SESSIONS_DEFAULT_LIMIT } from './list-sessions.js';
import { callTool } from './test-tool-call.js';

/**
 * `list_sessions`, against a fleet state that is a value.
 *
 * Three questions, and they are the ones a bounded listing has to answer: are
 * the filters the filters a caller asked for, is what survives the limit the
 * part worth keeping, and does the answer say what it left out.
 */

const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const WORKSHOP = serverRegistrationIdSchema.parse('registration-workshop');
const WORK = storeIdSchema.parse('store-work');
const HOME = storeIdSchema.parse('store-home');
const START = 1_756_000_000_000;

function descriptorOf(
  sessionId: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    storeId: WORK,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status: 'idle',
    updatedAt: START,
    cwd: '/volumes/work',
    branch: 'master',
    title: null,
    uncommitted: null,
    ...overrides,
  };
}

function rowOf(descriptor: SessionDescriptor, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    descriptor,
    source: ATTIC,
    reportedBy: [ATTIC],
    reportedAt: START,
    reachable: true,
    holder: null,
    acknowledgedThrough: null,
    mutedAt: null,
    ...overrides,
  };
}

function storeOf(storeId: StoreView['storeId'], sessions: readonly SessionRow[]): StoreView {
  return {
    storeId,
    servers: [ATTIC],
    reachable: true,
    unreachableSince: null,
    lastReachableAt: START,
    sessions: [...sessions],
  };
}

function fleetOf(stores: readonly StoreView[]): MachineState {
  return { version: 3, stores: [...stores], servers: [], candidates: [] };
}

function listing(
  state: MachineState,
  args: Record<string, unknown> = {},
): ReturnType<typeof callTool> {
  return callTool(listSessionsTool({ state: { published: () => state } }), args);
}

interface Listed {
  readonly sessions: { readonly sessionId: string; readonly storeId: string }[];
  readonly matched: number;
  readonly omitted: number;
}

describe('list_sessions', () => {
  it('flattens the stores away, because a question about a fleet crosses them', async () => {
    const state = fleetOf([
      storeOf(WORK, [rowOf(descriptorOf('a'))]),
      storeOf(HOME, [rowOf(descriptorOf('b', { storeId: HOME }))]),
    ]);

    const answered = (await listing(state)).structured as unknown as Listed;

    // One list, with the store on every row. A tree would make the model do the
    // flattening for a question that was never about stores.
    expect(answered.sessions.map((row) => [row.storeId, row.sessionId])).toEqual([
      [WORK, 'a'],
      [HOME, 'b'],
    ]);
    expect(answered.matched).toBe(2);
    expect(answered.omitted).toBe(0);
  });

  it('carries the row a client draws: status, holder, directory, branch', async () => {
    const state = fleetOf([
      storeOf(WORK, [
        rowOf(
          descriptorOf('a', {
            status: 'awaiting-permission',
            title: 'fix the failing test',
            cwd: '/volumes/work/agentplex',
            branch: 'agx-43',
            updatedAt: START + 500,
          }),
          { holder: { server: ATTIC, stoppable: false }, reachable: true },
        ),
      ]),
    ]);

    const answered = (await listing(state)).structured as { sessions: Record<string, unknown>[] };

    expect(answered.sessions[0]).toEqual({
      storeId: WORK,
      sessionId: 'a',
      provider: 'claude',
      status: 'awaiting-permission',
      title: 'fix the failing test',
      cwd: '/volumes/work/agentplex',
      branch: 'agx-43',
      updatedAt: START + 500,
      // A busy holder gets no stop button, and that is the fact rather than the
      // drawing of it: the hub publishes `stoppable`, nothing here decides it.
      holder: { server: ATTIC, stoppable: false },
      reachable: true,
    });
  });

  it('keeps a session nobody can reach, labelled rather than removed', async () => {
    const state = fleetOf([
      storeOf(WORK, [rowOf(descriptorOf('a'), { reachable: false, holder: null })]),
    ]);

    const answered = (await listing(state)).structured as {
      sessions: { reachable: boolean }[];
    };

    // A row that vanished when a laptop went to sleep would read as work that
    // was never done. It stays, and `reachable` is what says it cannot
    // presently be acted on.
    expect(answered.sessions).toHaveLength(1);
    expect(answered.sessions[0]?.reachable).toBe(false);
  });

  it('filters by the machine that reported it, not by the machine holding it', async () => {
    // One volume, two machines. Both read the same transcripts, so both can see
    // the session; only one has the process. "Sessions on workshop" means what
    // workshop can see, and which machine is running it is `holder`, on the row.
    const state = fleetOf([
      storeOf(WORK, [
        rowOf(descriptorOf('shared'), {
          reportedBy: [ATTIC, WORKSHOP],
          holder: { server: ATTIC, stoppable: true },
        }),
        rowOf(descriptorOf('attic-only'), { reportedBy: [ATTIC] }),
      ]),
    ]);

    const onWorkshop = (await listing(state, { server: WORKSHOP })).structured as unknown as Listed;
    const onAttic = (await listing(state, { server: ATTIC })).structured as unknown as Listed;

    expect(onWorkshop.sessions.map((row) => row.sessionId)).toEqual(['shared']);
    expect(onAttic.sessions).toHaveLength(2);
  });

  it('filters by store, provider and status', async () => {
    const state = fleetOf([
      storeOf(WORK, [
        rowOf(descriptorOf('a', { provider: 'claude', status: 'working' })),
        rowOf(descriptorOf('b', { provider: 'codex', status: 'working' })),
        rowOf(descriptorOf('c', { provider: 'claude', status: 'awaiting-permission' })),
      ]),
      storeOf(HOME, [rowOf(descriptorOf('d', { storeId: HOME, provider: 'claude' }))]),
    ]);

    const byStore = (await listing(state, { store: HOME })).structured as unknown as Listed;
    const byProvider = (await listing(state, { provider: 'codex' }))
      .structured as unknown as Listed;
    const byStatus = (await listing(state, { status: 'awaiting-permission' }))
      .structured as unknown as Listed;

    expect(byStore.sessions.map((row) => row.sessionId)).toEqual(['d']);
    expect(byProvider.sessions.map((row) => row.sessionId)).toEqual(['b']);
    expect(byStatus.sessions.map((row) => row.sessionId)).toEqual(['c']);
  });

  it('answers a filter that matches nothing with an empty list rather than a refusal', async () => {
    // A machine unpaired between two calls is exactly this case, and a refusal
    // would turn a race into a failure a caller has to special-case.
    const state = fleetOf([storeOf(WORK, [rowOf(descriptorOf('a'))])]);

    const result = await listing(state, { server: 'registration-gone' });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ sessions: [], matched: 0, omitted: 0 });
  });

  it('keeps the most recently touched when it has to cut, and says how many it cut', async () => {
    const state = fleetOf([
      storeOf(WORK, [
        rowOf(descriptorOf('old', { updatedAt: START })),
        rowOf(descriptorOf('newest', { updatedAt: START + 2_000 })),
        rowOf(descriptorOf('middle', { updatedAt: START + 1_000 })),
      ]),
    ]);

    const answered = (await listing(state, { limit: 2 })).structured as unknown as Listed;

    // Newest first, and what the limit drops is the oldest. A bounded list that
    // cut off the newest rows would answer the question backwards.
    expect(answered.sessions.map((row) => row.sessionId)).toEqual(['newest', 'middle']);
    expect(answered.matched).toBe(3);
    expect(answered.omitted).toBe(1);
  });

  it('orders two sessions written in the same millisecond the same way every time', async () => {
    const state = fleetOf([
      storeOf(WORK, [
        rowOf(descriptorOf('b', { updatedAt: START })),
        rowOf(descriptorOf('a', { updatedAt: START })),
      ]),
    ]);

    const first = (await listing(state)).structured as unknown as Listed;
    const again = (await listing(state)).structured as unknown as Listed;

    // Without the tiebreak a caller tightening a filter between two calls could
    // be shown one row twice and one never.
    expect(first.sessions.map((row) => row.sessionId)).toEqual(['a', 'b']);
    expect(again.sessions).toEqual(first.sessions);
  });

  it('bounds an answer nobody bounded', async () => {
    const rows = Array.from({ length: LIST_SESSIONS_DEFAULT_LIMIT + 10 }, (_unused, at) =>
      rowOf(descriptorOf(`session-${String(at)}`, { updatedAt: START + at })),
    );

    const answered = (await listing(fleetOf([storeOf(WORK, rows)])))
      .structured as unknown as Listed;

    expect(answered.sessions).toHaveLength(LIST_SESSIONS_DEFAULT_LIMIT);
    expect(answered.matched).toBe(LIST_SESSIONS_DEFAULT_LIMIT + 10);
    expect(answered.omitted).toBe(10);
  });

  it('says it only reads', async () => {
    const tool = listSessionsTool({ state: { published: () => fleetOf([]) } });

    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});
