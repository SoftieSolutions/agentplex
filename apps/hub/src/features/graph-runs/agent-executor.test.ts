import { beforeEach, describe, expect, it } from 'vitest';
import {
  graphNodeSchema,
  serverAddressSchema,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type GraphNode,
  type NodeId,
  type ServerRegistrationId,
  type SessionDescriptor,
  type SessionHold,
  type SessionStatus,
  type StartId,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import { readyProvider } from '@agentplex/providers/testing';
import type { ServerConnectionReport } from '../servers/servers.js';
import { createFleetState, type FleetState } from '../fleet-state/fleet-state.js';
import type { StartOutcome, StartSessionRequest } from '../sessions/sessions.js';
import { createAgentExecutor, type AgentExecutor } from './agent-executor.js';
import type { StepContext, StepResult } from './walker.js';

/**
 * An AGENT step, against the real reducer and a start seam driven by hand.
 *
 * What is under test is the join: a start this hub made, the tag a server
 * later reports for it, and the row in the fleet state that says the agent
 * has stopped. The seams are the ones the hub composes with -- `Sessions.start`
 * and `FleetState` -- and the one the walker hands in, `StepContext`. The
 * start is a hand-written seam here rather than the shared fake because the
 * interesting cases are about *when* it answers: a tag that arrives before the
 * start resolves is the ordinary case on a fast machine, and a fake that
 * answered in the same tick could not show it.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});
const WORK = storeIdSchema.parse('store-work');
const PROJECT = 'node-project' as NodeId;
const ATTIC = 'registration-attic' as ServerRegistrationId;

const NODE: GraphNode = graphNodeSchema.parse({
  id: 'review',
  kind: 'agent',
  label: 'Rust reviewer',
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
  prompt: 'Review the Rust in this change.',
  provider: 'claude',
  storeId: WORK,
});

function connected(): ServerConnectionReport {
  return {
    registrationId: ATTIC,
    label: 'attic',
    address: serverAddressSchema.parse('wss://attic.example:8443'),
    serverId: null,
    phase: 'connected',
    providers: [readyProvider()],
    stores: [WORK],
    connectedSince: START,
    staleSince: null,
    lastConnectedAt: START,
    failedAttempts: 0,
    problem: null,
    staleReason: null,
    draining: null,
  };
}

function descriptor(sessionId: string, status: SessionStatus): SessionDescriptor {
  return {
    storeId: WORK,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status,
    updatedAt: START,
    cwd: '/srv/work',
    branch: null,
    title: null,
    uncommitted: null,
  };
}

/** A start seam whose answer the test releases when it chooses. */
interface DeferredSessions {
  start(request: StartSessionRequest): Promise<StartOutcome>;
  readonly requests: StartSessionRequest[];
  answer(outcome: StartOutcome): void;
}

function deferredSessions(): DeferredSessions {
  const requests: StartSessionRequest[] = [];
  let release: ((outcome: StartOutcome) => void) | null = null;
  return {
    requests,
    start(request) {
      requests.push(request);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    answer(outcome) {
      if (release === null) throw new Error('nothing has asked for a start');
      release(outcome);
      release = null;
    },
  };
}

function started(startId: StartId): StartOutcome {
  return { ok: true, storeId: WORK, sessionId: null, server: ATTIC, startId };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('the AGENT executor', () => {
  let state: FleetState;
  let sessions: DeferredSessions;
  let timers: FakeTimers;
  let executor: AgentExecutor;
  let cancelListeners: (() => void)[];
  let context: StepContext;
  const START_ID = startIdSchema.parse('start-1');

  /** One server reporting the store with these sessions and holds. */
  function report(sessions: readonly SessionDescriptor[], holding: readonly SessionHold[]): void {
    state.applySessions({
      registrationId: ATTIC,
      storeId: WORK,
      sessions,
      holding,
      reportedAt: START,
    });
  }

  beforeEach(() => {
    state = createFleetState({ logger });
    state.applyConnection(connected());
    report([], []);
    sessions = deferredSessions();
    timers = createFakeTimers();
    cancelListeners = [];
    executor = createAgentExecutor({ sessions, state, timers, logger, namingDeadlineMs: 30_000 });
    context = {
      document: { nodes: [NODE], edges: [] },
      attempt: 0,
      cancellation: {
        cancelled: false,
        onCancel: (listener) => {
          cancelListeners.push(listener);
          return () => {};
        },
      },
    };
  });

  function run(node: GraphNode = NODE, project: NodeId | null = PROJECT): Promise<StepResult> {
    return executor.forProject(project)(node as Extract<GraphNode, { kind: 'agent' }>, {}, context);
  }

  it('starts a session through the one start path, with the prompt, the store, the provider and the project', async () => {
    const pending = run();
    await settle();

    expect(sessions.requests).toEqual([
      {
        storeId: WORK,
        sessionId: null,
        provider: 'claude',
        prompt: 'Review the Rust in this change.',
        server: null,
        project: PROJECT,
      },
    ]);

    sessions.answer(started(START_ID));
    executor.noteStarts(WORK, [
      { startId: START_ID, sessionId: sessionIdSchema.parse('session-9') },
    ]);
    report(
      [descriptor('session-9', 'awaiting-input')],
      [{ sessionId: sessionIdSchema.parse('session-9'), stoppable: true, pause: 'none' }],
    );

    await expect(pending).resolves.toEqual({
      ok: true,
      output: { storeId: WORK, sessionId: 'session-9', status: 'awaiting-input' },
      next: null,
    });
  });

  it('hands a pinned machine to the start as the override', async () => {
    const pinned = graphNodeSchema.parse({ ...NODE, placement: { kind: 'pin', server: ATTIC } });
    const pending = run(pinned);
    await settle();

    expect(sessions.requests[0]?.server).toBe(ATTIC);
    sessions.answer({ ok: false, code: 'refused', problem: 'attic said no', holder: null });
    await expect(pending).resolves.toEqual({ ok: false, problem: 'attic said no' });
  });

  it('fails the step, naming the node, when the pinned machine is not connected', async () => {
    const pinned = graphNodeSchema.parse({
      ...NODE,
      placement: { kind: 'pin', server: 'registration-gone' },
    });

    await expect(run(pinned)).resolves.toEqual({
      ok: false,
      problem: 'Rust reviewer is pinned to a server this hub is not paired with',
    });
    expect(sessions.requests).toEqual([]);
  });

  it('takes a naming that arrived before the start answered, which is the ordinary order', async () => {
    const pending = run();
    await settle();

    // The server scanned and reported the tag while the hub was still walking
    // back up from the start's answer.
    executor.noteStarts(WORK, [
      { startId: START_ID, sessionId: sessionIdSchema.parse('session-9') },
    ]);
    report([descriptor('session-9', 'idle')], []);
    sessions.answer(started(START_ID));

    await expect(pending).resolves.toEqual({
      ok: true,
      output: { storeId: WORK, sessionId: 'session-9', status: 'idle' },
      next: null,
    });
  });

  it('ignores a tag that has no session yet, and one reported under another store', async () => {
    const pending = run();
    await settle();
    sessions.answer(started(START_ID));
    await settle();

    executor.noteStarts(WORK, [{ startId: START_ID, sessionId: null }]);
    executor.noteStarts(storeIdSchema.parse('store-other'), [
      { startId: START_ID, sessionId: sessionIdSchema.parse('session-elsewhere') },
    ]);
    await settle();
    expect(timers.pending).toBe(1);

    executor.noteStarts(WORK, [
      { startId: START_ID, sessionId: sessionIdSchema.parse('session-9') },
    ]);
    report([descriptor('session-9', 'idle')], []);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('fails a spawn that never names a session at the injected deadline, in a sentence', async () => {
    const pending = run();
    await settle();
    sessions.answer(started(START_ID));
    await settle();

    expect(timers.delays).toEqual([30_000]);
    timers.fireAll();

    await expect(pending).resolves.toEqual({
      ok: false,
      problem: 'Rust reviewer started on attic but no session was named within 30 seconds',
    });
  });

  describe('once the session is named', () => {
    const SESSION = sessionIdSchema.parse('session-9');
    const HELD: SessionHold = { sessionId: SESSION, stoppable: true, pause: 'none' };

    /**
     * Wrapped in an object rather than returned bare: an async function that
     * returns a promise adopts it, and `await named()` would then be awaiting
     * the step instead of the moment it was named.
     */
    async function named(): Promise<{ readonly pending: Promise<StepResult> }> {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: SESSION }]);
      await settle();
      return { pending };
    }

    /** Whether the step has settled, without waiting on it. */
    async function settled(pending: Promise<StepResult>): Promise<boolean> {
      let done = false;
      void pending.then(() => {
        done = true;
      });
      await settle();
      return done;
    }

    it('keeps waiting while the agent is working, and ends when it is awaiting input', async () => {
      const { pending } = await named();

      report([descriptor('session-9', 'working')], [HELD]);
      expect(await settled(pending)).toBe(false);

      report([descriptor('session-9', 'awaiting-input')], [HELD]);
      await expect(pending).resolves.toMatchObject({
        ok: true,
        output: { sessionId: 'session-9', status: 'awaiting-input' },
      });
    });

    it('ends on idle', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'idle')], [HELD]);
      await expect(pending).resolves.toMatchObject({ ok: true, output: { status: 'idle' } });
    });

    it('does not treat unknown as a boundary', async () => {
      const { pending } = await named();

      report([descriptor('session-9', 'unknown')], [HELD]);
      expect(await settled(pending)).toBe(false);

      report([descriptor('session-9', 'idle')], [HELD]);
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('keeps waiting through awaiting-permission: the agent is asking, not done', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'awaiting-permission')], [HELD]);
      expect(await settled(pending)).toBe(false);
    });

    it('ends when the holder disappears after being seen, and says the session ended mid-turn', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'working')], [HELD]);
      expect(await settled(pending)).toBe(false);

      report([descriptor('session-9', 'working')], []);

      await expect(pending).resolves.toEqual({
        ok: false,
        problem: 'the session session-9 that Rust reviewer started ended while it was working',
      });
    });

    it('ends when the row itself vanishes after being seen', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'working')], [HELD]);

      report([], []);

      await expect(pending).resolves.toEqual({
        ok: false,
        problem: 'the session session-9 that Rust reviewer started disappeared from the store',
      });
    });

    it('does not read a row that has not appeared yet as the session having ended', async () => {
      const { pending } = await named();
      // Two reports without the row: the scan has not caught up with the spawn.
      report([], []);
      report([], []);
      expect(await settled(pending)).toBe(false);

      report([descriptor('session-9', 'idle')], [HELD]);
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('stops waiting on a cancel and says so, leaving the session alone', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'working')], [HELD]);

      for (const listener of cancelListeners) listener();

      await expect(pending).resolves.toEqual({
        ok: false,
        problem:
          'the run was cancelled while Rust reviewer was running; its session was left alone',
      });
    });
  });
});
