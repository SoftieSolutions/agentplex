import type {
  GraphNode,
  NodeId,
  SessionId,
  SessionRef,
  SessionStartTag,
  StartId,
  StoreId,
} from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';
import type { FleetState, HubStateSnapshot, SessionRow } from '../fleet-state/fleet-state.js';
import type { Sessions, StartPlacement } from '../sessions/sessions.js';
import { createStartNaming } from '../start-naming/start-naming.js';
import { placeNode } from './placement.js';
import { nameOf, type Executor, type StepResult } from './walker.js';

/**
 * An AGENT step: start a session, wait for it to finish, say what it was.
 *
 * ## One start path
 *
 * The session is started through `Sessions.start`, which is the path every
 * client's start takes: it resolves the project to a directory out of the
 * hub's own rows, routes the start, mints the start id and tells the tasks
 * feature the prompt -- so a graph-spawned session appears in every session
 * list like any other, with its TASK set to the node's prompt. Nothing here
 * spawns, names a directory or reaches a machine.
 *
 * ## The two moments a start has
 *
 * A spawn has no session id when it is started. The provider mints one and
 * writes it, and the hub learns the pair from the start tag a server reports
 * -- which lands on another socket, and more often than not before the start's
 * own answer has walked back up here. `tasks.ts` argues the race at length;
 * this file resolves it with the same join, `start-naming`, in an instance of
 * its own: a naming that arrives first is held for its start to claim, and a
 * start that arrives first waits for its naming. Whichever completes the pair
 * moves on.
 *
 * A spawn that dies before its provider writes anything never gets a name,
 * and a step that waited on one would wait forever. So the wait has a
 * deadline, injected, and passing it is a failed attempt with a sentence --
 * which the node's own retry policy may then try again. The deadline is the
 * join's own, given this executor's naming deadline, so a start waits on one
 * timer and not two; a naming held for nobody is dropped at the same one,
 * since no attempt here waits longer for it than that.
 *
 * ## A spawn nobody is waiting for any more
 *
 * A spawn that names itself after its attempt gave up on it -- a slow machine
 * past the deadline, or a run cancelled while it was starting -- is a real
 * process with nobody watching it. It is stopped through `Sessions.stop`, the
 * path every client's stop takes, and the naming is not kept: `abandoned`
 * remembers each start that was given up on so that its late tag is a stop
 * and not a naming held for a start that will never ask again. A spawn
 * that was named before its start answered, on a run cancelled meanwhile, is
 * the same process by an earlier road, and it is stopped the same way at once.
 *
 * Nothing makes a retry wait for the previous attempt's spawn: attempts are
 * sequential, and an attempt ends only once its spawn is named or abandoned,
 * so a retry after a deadline can start while the abandoned spawn is still
 * coming up. What bounds that leak is abandoned-then-stop -- every abandoned
 * spawn that ever names itself is stopped -- and not a lock across attempts.
 *
 * An abandoned start is remembered until its stop is answered, or for one
 * more naming deadline if nothing ever names it: a spawn that has said
 * nothing for twice the deadline is taken to have died, and a hub that
 * remembered every one for its whole life would grow by one entry per failed
 * spawn. The cost is that a spawn slower than that is left running; that is
 * the bargain, made in the direction of a bounded hub.
 *
 * A session that completes a step is a different matter, and it is left
 * alive on purpose. It is the step's output -- the row the next node's
 * conditions read and the transcript a person opens to see what the agent
 * did -- and stopping it would throw away the one thing the step made.
 *
 * ## When an agent is done
 *
 * The step ends on the fleet state's word and nothing else: the row for
 * `{ storeId, sessionId }` reading `idle` or `awaiting-input`, or the holder
 * this hub saw on it going away. `unknown` is deliberately not a boundary --
 * it is the adapter saying it could not tell, and a step that ended on it
 * would be ending on a shrug. `awaiting-permission` is the agent asking, and
 * `working` is the agent working; both are waits. A holder that vanishes
 * while the row still says `working` is a process that died mid-turn, and
 * that is a failure with the status in the sentence rather than a success
 * with nothing to show for it.
 *
 * The row is watched, not polled: `FleetState.subscribe` publishes every
 * change, and each snapshot is read for this one row. What the executor does
 * not do is trust a snapshot that has not caught up yet -- a row that is not
 * there before it has ever been seen is a scan that has not run, not a
 * session that ended. A row that is there, not at a boundary, and held by
 * nobody this hub can see is the one case neither rule covers: nothing will
 * ever vanish from it, so it gets the same deadline a naming does, dropped
 * the moment a holder appears.
 */

export interface AgentExecutorDependencies {
  readonly sessions: Pick<Sessions, 'start' | 'stop' | 'placeStart'>;
  readonly state: Pick<FleetState, 'snapshot' | 'subscribe'>;
  readonly timers: Timers;
  readonly logger: Logger;
  /** How long a spawn may go without naming a session before the attempt fails. */
  readonly namingDeadlineMs?: number;
}

export interface AgentExecutor {
  /**
   * The executor for one run: its graph's project is what the session starts
   * in, so the walker's table is built per run.
   */
  forProject(project: NodeId | null): Executor<'agent'>;
  /**
   * Where this node's session would start, answered without starting it: the
   * node's pin checked the way a step checks it, then the hub's one start
   * routing asked. What a simulation reports for an AGENT, so the machine it
   * names is the machine a run would have used.
   */
  place(node: Extract<GraphNode, { kind: 'agent' }>): StartPlacement;
  /**
   * Takes the start tags one server reported for one store, which is how a
   * spawn's session id reaches this feature. Wired beside `tasks.noteStarts`.
   */
  noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void;
}

const DEFAULT_NAMING_DEADLINE_MS = 120_000;

/** A status that says the agent has stopped working and is waiting to be spoken to. */
function isBoundary(status: SessionRow['descriptor']['status']): boolean {
  return status === 'idle' || status === 'awaiting-input';
}

function findRow(snapshot: HubStateSnapshot, ref: SessionRef): SessionRow | undefined {
  return snapshot.stores
    .find((store) => store.storeId === ref.storeId)
    ?.sessions.find((row) => row.ref.sessionId === ref.sessionId);
}

export function createAgentExecutor(dependencies: AgentExecutorDependencies): AgentExecutor {
  const { sessions, state, timers } = dependencies;
  const logger = dependencies.logger.child({ part: 'graph-runs/agent' });
  const deadlineMs = dependencies.namingDeadlineMs ?? DEFAULT_NAMING_DEADLINE_MS;

  /** Each spawn's naming, joined with its start in whichever order they come. */
  const naming = createStartNaming({ timers, logger, ttlMs: deadlineMs });
  /**
   * Starts whose attempt gave up on them, the session each was later stopped
   * as, if any, and the cancel of the deadline after which it is forgotten.
   */
  const abandoned = new Map<
    StartId,
    { readonly storeId: StoreId; stopped: SessionId | null; readonly forget: () => void }
  >();

  /** Remembers a start its attempt gave up on, for a bounded while. */
  function abandon(startId: StartId, storeId: StoreId): void {
    const forget = timers.schedule(deadlineMs, () => void abandoned.delete(startId));
    abandoned.set(startId, { storeId, stopped: null, forget });
  }

  /** Stops a spawn nobody is waiting for, through the path every stop takes. */
  function stopSpawn(ref: SessionRef, settled: () => void): void {
    const failed = (problem: string): void => {
      logger.warn('a spawn nobody is waiting for could not be stopped', { ...ref, problem });
    };
    sessions.stop(ref).then(
      (stopped) => {
        if (!stopped.ok) failed(stopped.problem);
        settled();
      },
      (error: unknown) => {
        failed(String(error));
        settled();
      },
    );
  }
  /** The session a start became, once a server says so, or `null` at the deadline or on cancel. */
  function awaitNaming(
    startId: StartId,
    storeId: StoreId,
    onCancel: (listener: () => void) => () => void,
  ): Promise<SessionRef | null> {
    const already = naming.claim(startId, storeId);
    if (already !== null) return Promise.resolve(already);
    return new Promise((resolve) => {
      let settled = false;
      let stopWaiting: (() => void) | null = null;
      let detach: (() => void) | null = null;
      const finish = (ref: SessionRef | null): void => {
        if (settled) return;
        settled = true;
        stopWaiting?.();
        detach?.();
        if (ref === null) abandon(startId, storeId);
        resolve(ref);
      };
      stopWaiting = naming.expect(startId, storeId, finish);
      // A run already cancelled answers at once, before this returns.
      detach = onCancel(() => finish(null));
      if (settled) detach();
    });
  }

  /** Watches the row until the agent has stopped, and says how. */
  function awaitEnd(
    node: Extract<GraphNode, { kind: 'agent' }>,
    ref: SessionRef,
    onCancel: (listener: () => void) => () => void,
  ): Promise<StepResult> {
    return new Promise((resolve) => {
      let seenHolder = false;
      let seenRow = false;
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let detach: (() => void) | null = null;
      /** Running while the row is held by nobody and at no boundary. */
      let cancelUnheldDeadline: (() => void) | null = null;
      let lastStatus: SessionRow['descriptor']['status'] = 'unknown';

      const finish = (result: StepResult): void => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        detach?.();
        cancelUnheldDeadline?.();
        resolve(result);
      };

      const read = (snapshot: HubStateSnapshot): void => {
        const row = findRow(snapshot, ref);
        if (row === undefined) {
          if (seenRow) {
            finish({
              ok: false,
              problem: `the session ${ref.sessionId} that ${nameOf(node)} started disappeared from the store`,
            });
          }
          return;
        }
        seenRow = true;
        const status = row.descriptor.status;
        lastStatus = status;
        if (isBoundary(status)) {
          const session = { storeId: ref.storeId, sessionId: ref.sessionId, status };
          finish({
            ok: true,
            carried: session,
            output: { kind: 'session', ...session },
            next: null,
          });
          return;
        }
        if (row.holder !== null) {
          seenHolder = true;
          cancelUnheldDeadline?.();
          cancelUnheldDeadline = null;
          return;
        }
        if (seenHolder) {
          finish({
            ok: false,
            problem: `the session ${ref.sessionId} that ${nameOf(node)} started ended while it was ${status}`,
          });
          return;
        }
        if (cancelUnheldDeadline === null) {
          cancelUnheldDeadline = timers.schedule(deadlineMs, () =>
            finish({
              ok: false,
              problem: `the session ${ref.sessionId} that ${nameOf(node)} started was ${lastStatus} with nothing holding it, and did not stop within ${String(Math.round(deadlineMs / 1_000))} seconds`,
            }),
          );
        }
      };

      detach = onCancel(() =>
        finish({
          ok: false,
          problem: `the run was cancelled while ${nameOf(node)} was running; its session was left alone`,
        }),
      );
      if (settled) return;
      unsubscribe = state.subscribe(read);
      read(state.snapshot());
    });
  }

  return {
    place(node: Extract<GraphNode, { kind: 'agent' }>): StartPlacement {
      const placed = placeNode(state.snapshot(), node);
      if (!placed.ok) return { ok: false, problem: placed.problem };
      return sessions.placeStart({
        storeId: node.storeId,
        provider: node.provider,
        server: placed.server,
      });
    },

    forProject(project: NodeId | null): Executor<'agent'> {
      return async (node, _input, context) => {
        const placed = placeNode(state.snapshot(), node);
        if (!placed.ok) return { ok: false, problem: placed.problem };

        if (context.cancellation.cancelled) {
          return {
            ok: false,
            problem: `the run was cancelled before ${nameOf(node)} started`,
          };
        }

        const outcome = await sessions.start({
          storeId: node.storeId,
          sessionId: null,
          provider: node.provider,
          prompt: node.prompt,
          server: placed.server,
          project,
        });
        if (!outcome.ok) return { ok: false, problem: outcome.problem };

        const onCancel = context.cancellation.onCancel.bind(context.cancellation);
        let ref: SessionRef | null;
        if (outcome.sessionId === null) {
          ref = await awaitNaming(outcome.startId, outcome.storeId, onCancel);
        } else {
          ref = { storeId: outcome.storeId, sessionId: outcome.sessionId };
        }
        if (ref !== null && context.cancellation.cancelled) {
          // Named before the start answered, and the run was cancelled in
          // between: the spawn is this step's and nobody will wait on it.
          logger.info('a run was cancelled as its spawn was named; stopping it', {
            node: node.id,
            startId: outcome.startId,
            ...ref,
          });
          stopSpawn(ref, () => {});
          return {
            ok: false,
            problem: `the run was cancelled while ${nameOf(node)} was starting; its session was stopped`,
          };
        }
        if (ref === null) {
          if (context.cancellation.cancelled) {
            return {
              ok: false,
              problem: `the run was cancelled while ${nameOf(node)} was starting; its session will be stopped when a server names it`,
            };
          }
          const where =
            state.snapshot().servers.find((server) => server.registrationId === outcome.server)
              ?.label ?? outcome.server;
          return {
            ok: false,
            problem: `${nameOf(node)} started on ${where} but no session was named within ${String(Math.round(deadlineMs / 1_000))} seconds`,
          };
        }

        logger.info('a graph step is running as a session', {
          node: node.id,
          startId: outcome.startId,
          ...ref,
        });
        return awaitEnd(node, ref, onCancel);
      };
    },

    noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void {
      const live: SessionStartTag[] = [];
      for (const tag of starts) {
        if (tag.sessionId === null) continue;
        const givenUp = abandoned.get(tag.startId);
        if (givenUp === undefined) {
          live.push(tag);
          continue;
        }
        // Named too late: the attempt has failed or was cancelled, and a
        // PTY is running with nobody watching it. Stopped once, through
        // the path every stop takes; a scan that reports the tag again
        // finds it already stopped here.
        if (givenUp.stopped === tag.sessionId) continue;
        givenUp.stopped = tag.sessionId;
        const ref: SessionRef = { storeId, sessionId: tag.sessionId };
        logger.warn('a spawn named itself after its step gave up on it; stopping it', {
          startId: tag.startId,
          ...ref,
        });
        const startId = tag.startId;
        // Forgotten once the stop is answered, whichever way: the session
        // it named is gone or refused, and either way nothing here will
        // stop it again.
        stopSpawn(ref, () => {
          givenUp.forget();
          abandoned.delete(startId);
        });
      }
      // Every other naming goes to the join: to the start waiting on it, or
      // held for one whose answer is still on its way here. One that was not
      // a graph's start at all costs a session ref until the deadline. Not
      // awaited: what a naming sets going here is a step's own promise.
      void naming.named(storeId, live);
    },
  };
}
