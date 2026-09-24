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
import { sessionStatusTool } from './session-status.js';
import { callTool } from './test-tool-call.js';

/**
 * `session_status`, against a fleet state that is a value.
 *
 * The row `list_sessions` returns is already covered where it is built. What is
 * under test here is the part only this tool has: the two facts a listing has
 * no room for, the difference between "nobody counted" and "it cost nothing",
 * and what a session nobody has heard of is answered with.
 */

const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
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
    status: 'working',
    updatedAt: START,
    cwd: '/volumes/work',
    branch: 'master',
    title: null,
    uncommitted: null,
    ...overrides,
  };
}

function fleetWith(
  descriptor: SessionDescriptor,
  holder: SessionRow['holder'] = null,
): MachineState {
  const store: StoreView = {
    storeId: descriptor.storeId,
    servers: [ATTIC],
    reachable: true,
    unreachableSince: null,
    lastReachableAt: START,
    sessions: [
      {
        descriptor,
        source: ATTIC,
        reportedBy: [ATTIC],
        reportedAt: START,
        reachable: true,
        holder,
        acknowledgedThrough: null,
        mutedAt: null,
        project: null,
        approvals: [],
        task: null,
      },
    ],
  };
  return { version: 1, stores: [store], servers: [], candidates: [] };
}

function status(state: MachineState, args: Record<string, unknown>): ReturnType<typeof callTool> {
  return callTool(sessionStatusTool({ state: { published: () => state } }), args);
}

describe('session_status', () => {
  it('answers one session by its ref, with the diffstat and what it has spent', async () => {
    const state = fleetWith(
      descriptorOf('a', {
        title: 'fix the failing test',
        uncommitted: { files: 3, added: 42, removed: 7, entries: [] },
        usage: {
          inputTokens: 1_200,
          cacheReadTokens: 90_000,
          cacheWriteTokens: 4_000,
          outputTokens: 800,
        },
      }),
      { server: ATTIC, stoppable: true, pause: 'none' },
    );

    const result = await status(state, { storeId: WORK, sessionId: 'a' });

    expect(result.structured).toEqual({
      session: {
        storeId: WORK,
        sessionId: 'a',
        provider: 'claude',
        status: 'working',
        title: 'fix the failing test',
        cwd: '/volumes/work',
        branch: 'master',
        updatedAt: START,
        holder: { server: ATTIC, stoppable: true },
        reachable: true,
        // The three counts and not the per-file rows: which files changed is a
        // thing a client draws, and a diffstat is what an agent asks for.
        uncommitted: { files: 3, added: 42, removed: 7 },
        usage: {
          inputTokens: 1_200,
          cacheReadTokens: 90_000,
          cacheWriteTokens: 4_000,
          outputTokens: 800,
        },
      },
    });
  });

  it('says nobody looked rather than nothing was found', async () => {
    // The direction that does not over-claim. A zeroed diffstat says a person
    // has nothing outstanding; `null` says the machine did not read the
    // directory, which is every case from "not a repository" to "the scan had
    // already looked at enough directories". Same for a provider that counts no
    // tokens: absent is not free.
    const state = fleetWith(descriptorOf('a', { uncommitted: null }));

    const result = await status(state, { storeId: WORK, sessionId: 'a' });

    const answered = result.structured as { session: { uncommitted: unknown; usage: unknown } };
    expect(answered.session.uncommitted).toBeNull();
    expect(answered.session.usage).toBeNull();
  });

  it('refuses a session this hub has not been told about, naming both halves', async () => {
    const state = fleetWith(descriptorOf('a'));

    const wrongSession = await status(state, { storeId: WORK, sessionId: 'b' });
    const wrongStore = await status(state, { storeId: HOME, sessionId: 'a' });

    // An empty answer and a missing session are different facts, and only one
    // of them is true. Both halves of the identity are named because either one
    // can be the wrong half.
    expect(wrongSession.isError).toBe(true);
    expect(wrongSession.text).toContain('no session b in store store-work');
    expect(wrongSession.structured).toBeUndefined();
    expect(wrongStore.isError).toBe(true);
    expect(wrongStore.text).toContain('store store-home');
  });

  it('says it only reads', () => {
    const tool = sessionStatusTool({
      state: { published: () => fleetWith(descriptorOf('a')) },
    });

    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});
