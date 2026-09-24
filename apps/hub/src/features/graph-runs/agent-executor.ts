import type {
  GraphNode,
  NodeId,
  SessionRef,
  SessionStartTag,
  StartId,
  StoreId,
} from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';
import type { FleetState, HubStateSnapshot, SessionRow } from '../fleet-state/fleet-state.js';
import type { Sessions } from '../sessions/sessions.js';
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
 * this file resolves it the same way, with two maps: a naming that arrives
 * first waits in `named` for its start, and a start that arrives first waits in
 * `awaiting` for its naming. Whichever completes the pair moves on.
 *
 * A spawn that dies before its provider writes anything never gets a name,
 * and a step that waited on one would wait forever. So the wait has a
 * deadline, injected, and passing it is a failed attempt with a sentence --
 * which the node's own retry policy may then try again.
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
 * session that ended.
 */

export interface AgentExecutorDependencies {
  readonly sessions: Pick<Sessions, 'start'>;
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

  /** Namings that arrived before their start did. */
  const named = new Map<StartId, SessionRef>();
  /** Starts waiting to be named, with what to do when they are. */
  const awaiting = new Map<
    StartId,
    { readonly storeId: StoreId; readonly name: (ref: SessionRef) => void }
  >();

  const sameStore = (startId: StartId, asked: StoreId, ref: SessionRef): boolean => {
    if (asked === ref.storeId) return true;
    logger.warn('a start was reported under a store it was not made for', {
      startId,
      asked,
      reported: ref.storeId,
    });
    return false;
  };

  /** The session a start became, once a server says so, or `null` at the deadline or on cancel. */
  function awaitNaming(
    startId: StartId,
    storeId: StoreId,
    onCancel: (listener: () => void) => () => void,
  ): Promise<SessionRef | null> {
    const already = named.get(startId);
    if (already !== undefined) {
      named.delete(startId);
      return Promise.resolve(sameStore(startId, storeId, already) ? already : null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ref: SessionRef | null): void => {
        if (settled) return;
        settled = true;
        awaiting.delete(startId);
        cancelDeadline();
        detach();
        resolve(ref);
      };
      const cancelDeadline = timers.schedule(deadlineMs, () => finish(null));
      const detach = onCancel(() => finish(null));
      awaiting.set(startId, { storeId, name: (ref) => finish(ref) });
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

      const finish = (result: StepResult): void => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        detach?.();
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
        if (isBoundary(status)) {
          finish({
            ok: true,
            output: { storeId: ref.storeId, sessionId: ref.sessionId, status },
            next: null,
          });
          return;
        }
        if (row.holder !== null) {
          seenHolder = true;
          return;
        }
        if (seenHolder) {
          finish({
            ok: false,
            problem: `the session ${ref.sessionId} that ${nameOf(node)} started ended while it was ${status}`,
          });
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
    forProject(project: NodeId | null): Executor<'agent'> {
      return async (node, _input, context) => {
        const placed = placeNode(state.snapshot(), node);
        if (!placed.ok) return { ok: false, problem: placed.problem };

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
        const ref: SessionRef | null =
          outcome.sessionId === null
            ? await awaitNaming(outcome.startId, outcome.storeId, onCancel)
            : { storeId: outcome.storeId, sessionId: outcome.sessionId };
        if (ref === null) {
          if (context.cancellation.cancelled) {
            return {
              ok: false,
              problem: `the run was cancelled while ${nameOf(node)} was starting; its session was left alone`,
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
      for (const tag of starts) {
        if (tag.sessionId === null) continue;
        const ref: SessionRef = { storeId, sessionId: tag.sessionId };
        const waiting = awaiting.get(tag.startId);
        if (waiting === undefined) {
          // Nothing waiting: the start's answer is still on its way here, or
          // this was not a graph's start at all. Kept for the first case; the
          // second costs one session ref, which is the bargain `tasks.ts` makes.
          named.set(tag.startId, ref);
          continue;
        }
        if (!sameStore(tag.startId, waiting.storeId, ref)) continue;
        waiting.name(ref);
      }
    },
  };
}
