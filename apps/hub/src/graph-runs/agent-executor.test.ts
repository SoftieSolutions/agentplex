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
import type {
  StartOutcome,
  StartPlacement,
  StartPlacementRequest,
  StartSessionRequest,
  SessionOutcome,
  StopSessionRequest,
} from '../sessions/sessions.js';
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

/**
 * A start seam whose answer the test releases when it chooses, and that
 * records every stop and answers each one only when the test says so.
 */
interface DeferredSessions {
  start(request: StartSessionRequest): Promise<StartOutcome>;
  placeStart(request: StartPlacementRequest): StartPlacement;
  readonly placements: StartPlacementRequest[];
  /** What every later placement answers with. */
  placeWith(placement: StartPlacement): void;
  stop(request: StopSessionRequest): Promise<SessionOutcome>;
  readonly requests: StartSessionRequest[];
  readonly stops: StopSessionRequest[];
  answer(outcome: StartOutcome): void;
  /** Answers every stop asked for so far with the machine's yes. */
  answerStops(): void;
}

function deferredSessions(): DeferredSessions {
  const requests: StartSessionRequest[] = [];
  const stops: StopSessionRequest[] = [];
  const placements: StartPlacementRequest[] = [];
  let placement: StartPlacement = { ok: true, server: ATTIC, label: 'attic' };
  const stopAnswers: ((outcome: SessionOutcome) => void)[] = [];
  let release: ((outcome: StartOutcome) => void) | null = null;
  return {
    requests,
    stops,
    placements,
    placeStart(request) {
      placements.push(request);
      return placement;
    },
    placeWith(next) {
      placement = next;
    },
    start(request) {
      requests.push(request);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    stop(request) {
      stops.push(request);
      return new Promise((resolve) => {
        stopAnswers.push(resolve);
      });
    },
    answer(outcome) {
      if (release === null) throw new Error('nothing has asked for a start');
      release(outcome);
      release = null;
    },
    answerStops() {
      for (const answer of stopAnswers.splice(0)) {
        answer({ ok: true, storeId: WORK, sessionId: null, server: ATTIC });
      }
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
  /** Cancels the run the step belongs to, the way the walker does. */
  let cancel: () => void;
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
    executor = createAgentExecutor({ sessions, state, timers, logger, namingDeadlineMs: 30_000 });
    // Shaped like the walker's own: a listener added after the cancel is
    // called at once, which is what a step that awaits past a cancel meets.
    const listeners = new Set<() => void>();
    let cancelled = false;
    cancel = () => {
      cancelled = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    };
    context = {
      document: { nodes: [NODE], edges: [] },
      waiting: () => {},
      child: () => {},
      attempt: 0,
      cancellation: {
        get cancelled() {
          return cancelled;
        },
        onCancel: (listener) => {
          if (cancelled) {
            listener();
            return () => {};
          }
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
    };
  });

  function run(node: GraphNode = NODE, project: NodeId | null = PROJECT): Promise<StepResult> {
    return executor.forProject(project)(node as Extract<GraphNode, { kind: 'agent' }>, {}, context);
  }

  describe('placing a node without starting it', () => {
    it('asks the one start routing where a cheapest node would go, and starts nothing', () => {
      expect(executor.place(NODE as Extract<GraphNode, { kind: 'agent' }>)).toEqual({
        ok: true,
        server: ATTIC,
        label: 'attic',
      });
      expect(sessions.placements).toEqual([{ storeId: WORK, provider: 'claude', server: null }]);
      expect(sessions.requests).toEqual([]);
      expect(timers.pending).toBe(0);
    });

    it('asks it for the pinned machine when the node is pinned to one that is connected', () => {
      const pinned = { ...NODE, placement: { kind: 'pin', server: ATTIC } } as Extract<
        GraphNode,
        { kind: 'agent' }
      >;
      executor.place(pinned);
      expect(sessions.placements).toEqual([{ storeId: WORK, provider: 'claude', server: ATTIC }]);
    });

    it('says why no machine would take it, in the routing’s words or the pin’s', () => {
      sessions.placeWith({ ok: false, problem: 'attic does not run claude' });
      expect(executor.place(NODE as Extract<GraphNode, { kind: 'agent' }>)).toEqual({
        ok: false,
        problem: 'attic does not run claude',
      });

      const elsewhere = {
        ...NODE,
        placement: { kind: 'pin', server: 'registration-gone' },
      } as Extract<GraphNode, { kind: 'agent' }>;
      expect(executor.place(elsewhere)).toEqual({
        ok: false,
        problem: 'Rust reviewer is pinned to a server this hub is not paired with',
      });
      // Refused by the pin before the routing was asked.
      expect(sessions.placements).toHaveLength(1);
      expect(sessions.requests).toEqual([]);
    });
  });

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
      carried: { storeId: WORK, sessionId: 'session-9', status: 'awaiting-input' },
      output: { kind: 'session', storeId: WORK, sessionId: 'session-9', status: 'awaiting-input' },
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
      carried: { storeId: WORK, sessionId: 'session-9', status: 'idle' },
      output: { kind: 'session', storeId: WORK, sessionId: 'session-9', status: 'idle' },
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

  it('refuses a naming that arrived first under a store the start was not made for', async () => {
    const pending = run();
    await settle();
    // Named under another store before the start answered: the step must not
    // go on to watch a session in a store its node does not name.
    executor.noteStarts(storeIdSchema.parse('store-other'), [
      { startId: START_ID, sessionId: sessionIdSchema.parse('session-elsewhere') },
    ]);
    sessions.answer(started(START_ID));
    await settle();

    // Refused, and the start waits for a naming under its own store for the
    // one deadline it has; the refused naming holds nothing of its own.
    expect(timers.delays).toEqual([30_000]);
    timers.fireAll();
    await expect(pending).resolves.toEqual({
      ok: false,
      problem: 'Rust reviewer started on attic but no session was named within 30 seconds',
    });
    expect(sessions.stops).toEqual([]);
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

  describe('a spawn named after its attempt was over', () => {
    const LATE = sessionIdSchema.parse('session-late');

    it('is stopped through the one stop path when the attempt failed at the deadline', async () => {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      timers.fireAll();
      await expect(pending).resolves.toMatchObject({ ok: false });

      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      await settle();

      // The PTY the attempt gave up on is not left running with nobody
      // watching it, and it is not kept as a naming for a start that will
      // never ask again.
      expect(sessions.stops).toEqual([{ storeId: WORK, sessionId: LATE }]);
    });

    it('is stopped when the attempt was cancelled while it was starting', async () => {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      cancel();
      // Says what will happen to the spawn, which is not being left alone.
      await expect(pending).resolves.toEqual({
        ok: false,
        problem:
          'the run was cancelled while Rust reviewer was starting; its session will be stopped when a server names it',
      });

      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      await settle();

      expect(sessions.stops).toEqual([{ storeId: WORK, sessionId: LATE }]);
    });

    it('is stopped once, however many scans report the same tag', async () => {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      timers.fireAll();
      await pending;

      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      await settle();

      expect(sessions.stops).toHaveLength(1);
    });

    it('is stopped at once when it was named before the start answered, on a run cancelled meanwhile', async () => {
      const pending = run();
      await settle();
      // The tag lands first, which is the ordinary order, and the run is
      // cancelled before the start's answer walks back up here.
      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      cancel();
      sessions.answer(started(START_ID));

      await expect(pending).resolves.toEqual({
        ok: false,
        problem: 'the run was cancelled while Rust reviewer was starting; its session was stopped',
      });
      expect(sessions.stops).toEqual([{ storeId: WORK, sessionId: LATE }]);
    });

    it('is forgotten once its stop is answered, and takes its deadline with it', async () => {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      timers.fireAll();
      await pending;
      // The naming deadline has fired; what is left is the one that bounds
      // how long an abandoned start is remembered.
      expect(timers.pending).toBe(1);

      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      await settle();
      sessions.answerStops();
      await settle();

      expect(timers.pending).toBe(0);
    });

    it('is forgotten when nothing names it within a second deadline, and is not stopped after', async () => {
      const pending = run();
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      timers.fireAll();
      await pending;
      expect(timers.delays).toEqual([30_000]);

      timers.fireAll();
      executor.noteStarts(WORK, [{ startId: START_ID, sessionId: LATE }]);
      await settle();

      expect(sessions.stops).toEqual([]);
      // What the late tag leaves is a naming nobody will claim, held for its
      // own deadline like any other and gone after it.
      expect(timers.delays).toEqual([30_000]);
      timers.fireAll();
      expect(timers.pending).toBe(0);
    });
  });

  describe('two attempts of one node', () => {
    it('lets the second start go once the first spawn has passed its deadline', async () => {
      const step = executor.forProject(PROJECT);
      const first = step(NODE as Extract<GraphNode, { kind: 'agent' }>, {}, context);
      await settle();
      sessions.answer(started(START_ID));
      await settle();
      timers.fireAll();
      await expect(first).resolves.toMatchObject({ ok: false });

      void step(NODE as Extract<GraphNode, { kind: 'agent' }>, {}, { ...context, attempt: 1 });
      await settle();

      expect(sessions.requests).toHaveLength(2);
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

    it('fails at the deadline a row seen with nothing holding it that never stops', async () => {
      const { pending } = await named();
      // A row the scan found, working, held by no server this hub can see:
      // a process that died before any holder was reported, or one this hub
      // will never hear the end of. Without a bound it would wait for ever.
      report([descriptor('session-9', 'working')], []);
      expect(await settled(pending)).toBe(false);
      expect(timers.pending).toBe(1);

      timers.fireAll();

      await expect(pending).resolves.toEqual({
        ok: false,
        problem:
          'the session session-9 that Rust reviewer started was working with nothing holding it, and did not stop within 30 seconds',
      });
    });

    it('drops that deadline once a holder appears, and waits on the holder instead', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'working')], []);
      expect(timers.pending).toBe(1);

      report([descriptor('session-9', 'working')], [HELD]);
      expect(timers.pending).toBe(0);
      timers.fireAll();
      expect(await settled(pending)).toBe(false);

      report([descriptor('session-9', 'idle')], [HELD]);
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('stops waiting on a cancel and says so, leaving the session alone', async () => {
      const { pending } = await named();
      report([descriptor('session-9', 'working')], [HELD]);

      cancel();

      await expect(pending).resolves.toEqual({
        ok: false,
        problem:
          'the run was cancelled while Rust reviewer was running; its session was left alone',
      });
    });
  });
});
