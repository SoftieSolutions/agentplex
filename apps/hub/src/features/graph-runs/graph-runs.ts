import type {
  GraphRunId,
  GraphRunState,
  GraphRunStep,
  NodeId,
  RefusalCode,
  RouteInput,
  SessionStartTag,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger, Timers } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import type { Graphs } from '../graphs/graphs.js';
import type { AgentExecutor } from './agent-executor.js';
import { endRun, failRunningRuns, insertRun, replaceSteps } from './run-rows.js';
import { routerExecutor, triggerExecutor, walk, type Walk } from './walker.js';

/**
 * Runs, from the hub's side: start one, cancel one, and tell everybody where
 * each one is.
 *
 * ## What this file does around a step
 *
 * The walk is `walker.ts`'s and each step is an executor's. What is here is
 * everything a run needs that is not a step: the row it is numbered on, the
 * list of step records as they stand, the state published on every change,
 * and the end -- written to the row and published once more. It reads the
 * graph through the graphs feature's entry and nothing else of that folder,
 * and reaches no machine: the one executor that does is handed in.
 *
 * ## One state, published whole, on every change
 *
 * `onState` is called with the whole run each time anything about it moves,
 * the way approvals publish a session's whole list through `onChanged`. The
 * composition root wires it to the client broadcast, which sends it to every
 * attached client unsolicited; `subscribe(runId)` is the same stream for one
 * run, for whoever asked. Nothing here imports the thing it notifies.
 *
 * ## The row is written as it goes
 *
 * The steps are written on every record and the end is written once. A hub
 * that stops mid-run therefore leaves a row saying exactly how far it got,
 * which is what `load` reads at the next boot: every row still `running`
 * belongs to a process that is gone, and nothing resumes it -- a run waiting
 * on a machine or a person does not survive a restart, by decision -- so each
 * is ended `failed` with a reason naming the restart. The steps it had are
 * kept; a person reading run 38 sees where it stopped.
 */

export interface GraphRunsDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** What a retry's backoff waits on. */
  readonly timers: Timers;
  readonly logger: Logger;
  /** Where a run's document and project come from. The two reads and nothing else of that feature. */
  readonly graphs: Pick<Graphs, 'projectOf' | 'latestPublished'>;
  /** The one executor that reaches a machine, built where its seams are. */
  readonly agent: AgentExecutor;
  /**
   * Called with a run's whole state on every change, the way approvals'
   * `onChanged` is. Wired to the client broadcast by the composition root.
   */
  readonly onState: (state: GraphRunState) => void;
}

export interface GraphRunRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly problem: string;
}

export type RunStarted =
  { readonly ok: true; readonly runId: GraphRunId; readonly number: number } | GraphRunRefusal;

export type RunCancelled = { readonly ok: true } | GraphRunRefusal;

export interface GraphRuns {
  /**
   * Ends every run left running by the previous process. Called once, at
   * boot, before the first client is served.
   */
  load(): Promise<void>;
  /** Runs the graph's newest published version with this input, or refuses in words. */
  start(nodeId: NodeId, input: RouteInput): Promise<RunStarted>;
  /** Stops a run in flight before its next step. */
  cancel(runId: GraphRunId): Promise<RunCancelled>;
  /** Every state of one run from now until it ends. Returns the detach. */
  subscribe(runId: GraphRunId, onState: (state: GraphRunState) => void): () => void;
  /** The start tags one server reported, which is how a spawned step learns its session. */
  noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void;
}

const RESTART_REASON =
  'the hub restarted while this run was in flight; a waiting run does not survive a restart';

/** One run in flight: what is published about it, and the handle that stops it. */
interface ActiveRun {
  readonly runId: GraphRunId;
  readonly number: number;
  readonly of: number;
  step: number;
  steps: GraphRunStep[];
  walk: Walk | null;
}

export function createGraphRuns(dependencies: GraphRunsDependencies): GraphRuns {
  const { database, ids, clock, timers, graphs, agent, onState } = dependencies;
  const logger = dependencies.logger.child({ part: 'graph-runs' });

  const active = new Map<GraphRunId, ActiveRun>();
  const watchers = new Map<GraphRunId, Set<(state: GraphRunState) => void>>();

  const publish = (state: GraphRunState): void => {
    try {
      onState(state);
    } catch (error) {
      logger.warn('a run state could not be published', {
        runId: state.runId,
        problem: String(error),
      });
    }
    for (const watcher of watchers.get(state.runId) ?? []) {
      try {
        watcher(state);
      } catch (error) {
        logger.warn('a run watcher threw', { runId: state.runId, problem: String(error) });
      }
    }
  };

  const stateOf = (
    run: ActiveRun,
    status: GraphRunState['status'],
    reason: string | null,
  ): GraphRunState => ({
    runId: run.runId,
    number: run.number,
    status,
    reason,
    step: run.step,
    of: run.of,
    steps: [...run.steps],
  });

  /** Replaces the record for this attempt, or appends a new one. */
  const record = (run: ActiveRun, step: GraphRunStep): void => {
    const at = run.steps.findIndex(
      (held) => held.nodeId === step.nodeId && held.attempt === step.attempt,
    );
    if (at === -1) run.steps.push(step);
    else run.steps[at] = step;
  };

  return {
    async load(): Promise<void> {
      const swept = await failRunningRuns(database, clock.now(), RESTART_REASON);
      if (swept > 0)
        logger.warn('runs left in flight by the previous process were ended', { swept });
      else logger.info('no run was in flight at the last stop');
    },

    async start(nodeId: NodeId, input: RouteInput): Promise<RunStarted> {
      const project = await graphs.projectOf(nodeId);
      if (project === null) {
        return { ok: false, code: 'refused', problem: 'this hub has no graph by that id' };
      }
      const published = await graphs.latestPublished(nodeId);
      if (published === null) {
        return {
          ok: false,
          code: 'refused',
          problem: 'this graph has no published version to run; publish it first',
        };
      }

      const { runId, number } = await insertRun(database, ids, clock, {
        graphNodeId: nodeId,
        version: published.version,
        input,
      });
      const run: ActiveRun = {
        runId,
        number,
        of: published.document.nodes.length,
        step: 0,
        steps: [],
        walk: null,
      };
      active.set(runId, run);
      logger.info('run started', { nodeId, runId, number, version: published.version });
      publish(stateOf(run, 'running', null));

      const walking = walk(published.document, input, {
        executors: {
          trigger: triggerExecutor,
          router: routerExecutor,
          agent: agent.forProject(project),
        },
        timers,
        onStep: (step, reached) => {
          record(run, step);
          run.step = reached;
          // Not awaited: a step record that could not be written costs the
          // row its freshness and nothing else, and the end writes the whole
          // list again.
          replaceSteps(database, runId, run.steps).catch((error: unknown) => {
            logger.warn('a run’s steps could not be written', { runId, problem: String(error) });
          });
          publish(stateOf(run, 'running', null));
        },
      });
      run.walk = walking;

      void walking.done.then(async (outcome) => {
        const reason = outcome.status === 'failed' ? outcome.reason : null;
        try {
          await endRun(database, runId, {
            status: outcome.status,
            reason,
            steps: run.steps,
            endedAt: clock.now(),
          });
        } catch (error) {
          logger.error('a run’s end could not be written', { runId, problem: String(error) });
        }
        active.delete(runId);
        logger.info('run ended', { runId, number, status: outcome.status, reason });
        publish(stateOf(run, outcome.status, reason));
        watchers.delete(runId);
      });

      return { ok: true, runId, number };
    },

    async cancel(runId: GraphRunId): Promise<RunCancelled> {
      const run = active.get(runId);
      if (run === undefined || run.walk === null) {
        return { ok: false, code: 'refused', problem: 'no run by that id is in flight' };
      }
      logger.info('run cancel asked', { runId, number: run.number });
      run.walk.cancel();
      return { ok: true };
    },

    subscribe(runId: GraphRunId, watcher: (state: GraphRunState) => void): () => void {
      const held = watchers.get(runId) ?? new Set();
      watchers.set(runId, held);
      held.add(watcher);
      return () => {
        held.delete(watcher);
        if (held.size === 0) watchers.delete(runId);
      };
    },

    noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void {
      agent.noteStarts(storeId, starts);
    },
  };
}
