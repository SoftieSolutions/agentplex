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
import {
  endRun,
  failRunningRuns,
  insertRun,
  latestRun,
  replaceSteps,
  type RunRow,
} from './run-rows.js';
import { routerExecutor, triggerExecutor, walk, type Walk } from './walker.js';

/**
 * Runs, from the hub's side: start one, cancel one, say where each one is,
 * and answer where a graph's newest one stands.
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
 * ## One state, whole, once per change
 *
 * `onState` is called with the whole run each time it moves, the way
 * approvals publish a session's whole list through `onChanged`; the
 * composition root wires it to the client fan-out, which sends it to the
 * connections watching that graph. A change is not a record: the walker
 * reports a step's outcome and the next step's start in one synchronous
 * stretch, and the last outcome and the run's end likewise, so each run
 * publishes at most once per microtask and those pairs go out as one frame
 * rather than two lists a few characters apart.
 *
 * ## The caps
 *
 * A run holds an agent's session and a client's attention, and a hub has a
 * finite amount of both. Two bounds, refused in words: one run per graph at
 * a time -- a second Run on a graph still running is nearly always a person
 * pressing the button twice, and never something two agents should be doing
 * to the same repository -- and `GRAPH_RUNS_MAX_ACTIVE` across the hub. Both
 * are checked and reserved before the first `await`, so two starts in one
 * tick see each other.
 *
 * ## The row is written as it goes, in order
 *
 * The steps are written on every record and the end is written once, each
 * chained behind the run's previous write so two UPDATEs cannot cross and
 * leave an older list on the row. A hub that stops mid-run therefore leaves
 * a row saying exactly how far it got, which is what `load` reads at the
 * next boot: every row still `running` belongs to a process that is gone,
 * and nothing resumes it -- a run waiting on a machine or a person does not
 * survive a restart, by decision -- so each is ended `failed` with a reason
 * naming the restart. `stop` is the other half of that bargain: it cancels
 * every walk and then neither publishes nor writes, because the database is
 * closed behind it, and a row left `running` is exactly what the sweep is for.
 *
 * ## The end has a gap
 *
 * A run leaves `active` the instant its walk ends, before the end is written,
 * so a cancel that arrives in that gap is refused as already ended rather
 * than acknowledged into a row that is about to say `succeeded`. Until the
 * write lands, the ended state is held in `ending` so a read in the same gap
 * is answered from memory and not from a row still marked running.
 */

/** The most runs this hub walks at once, across every graph. */
export const GRAPH_RUNS_MAX_ACTIVE = 8;

export interface GraphRunsDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** What a retry's backoff waits on. */
  readonly timers: Timers;
  readonly logger: Logger;
  /** Where a run's document and project come from. Three reads and nothing else of that feature. */
  readonly graphs: Pick<Graphs, 'projectOf' | 'latestPublished' | 'publishedVersion'>;
  /** The one executor that reaches a machine, built where its seams are. */
  readonly agent: AgentExecutor;
  /**
   * Called with a run's whole state on every change, the way approvals'
   * `onChanged` is. Wired to the client fan-out by the composition root.
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
  /** The graph's newest run as it stands -- in flight, or as its row says -- or `null` when it has never run. */
  latest(nodeId: NodeId): Promise<GraphRunState | null>;
  /** The start tags one server reported, which is how a spawned step learns its session. */
  noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void;
  /** Cancels every walk in flight and publishes and writes nothing more. Called once, at shutdown. */
  stop(): void;
}

const RESTART_REASON =
  'the hub restarted while this run was in flight; a waiting run does not survive a restart';

/** One run in flight: what is published about it, and the handle that stops it. */
interface ActiveRun {
  readonly nodeId: NodeId;
  readonly runId: GraphRunId;
  readonly number: number;
  readonly of: number;
  step: number;
  steps: GraphRunStep[];
  walk: Walk | null;
  /** The state the queued flush will publish, or `null` when none is queued. */
  pending: GraphRunState | null;
  /** This run's writes to its row, one behind the other. */
  writes: Promise<void>;
}

function refused(problem: string): GraphRunRefusal {
  return { ok: false, code: 'refused', problem };
}

/** A row as a state: `step` is the visits made, which is one attempt 0 per node reached. */
function fromRow(row: RunRow, of: number): GraphRunState {
  return {
    nodeId: row.graphNodeId,
    runId: row.runId,
    number: row.number,
    status: row.status,
    reason: row.reason,
    step: row.steps.filter((step) => step.attempt === 0).length,
    of,
    steps: row.steps,
  };
}

export function createGraphRuns(dependencies: GraphRunsDependencies): GraphRuns {
  const { database, ids, clock, timers, graphs, agent, onState } = dependencies;
  const logger = dependencies.logger.child({ part: 'graph-runs' });

  const active = new Map<GraphRunId, ActiveRun>();
  /** The run in flight per graph, or `null` while one is being started. */
  const byGraph = new Map<NodeId, ActiveRun | null>();
  /** Runs that have ended and whose end is still being written, by graph. */
  const ending = new Map<NodeId, GraphRunState>();
  let stopped = false;

  const deliver = (state: GraphRunState): void => {
    try {
      onState(state);
    } catch (error) {
      logger.warn('a run state could not be published', {
        runId: state.runId,
        problem: String(error),
      });
    }
  };

  /** Publishes at the next microtask, the newest state only, so one change is one frame. */
  const publish = (run: ActiveRun, state: GraphRunState): void => {
    const queued = run.pending !== null;
    run.pending = state;
    if (queued) return;
    queueMicrotask(() => {
      const next = run.pending;
      run.pending = null;
      if (next === null || stopped) return;
      deliver(next);
    });
  };

  /** Chains a write behind this run's last one, skipped once stopped, and logged rather than thrown. */
  const write = (run: ActiveRun, what: string, act: () => Promise<void>): void => {
    run.writes = run.writes
      .then(() => (stopped ? undefined : act()))
      .catch((error: unknown) => {
        logger.warn(`a run’s ${what} could not be written`, {
          runId: run.runId,
          problem: String(error),
        });
      });
  };

  const stateOf = (
    run: ActiveRun,
    status: GraphRunState['status'],
    reason: string | null,
  ): GraphRunState => ({
    nodeId: run.nodeId,
    runId: run.runId,
    number: run.number,
    status,
    reason,
    step: run.step,
    of: run.of,
    steps: [...run.steps],
  });

  /**
   * Replaces the running record this outcome is of, or appends. The walker
   * reports an attempt's outcome directly after its running record, so the
   * record to replace is always the last one -- and a node a cycle reaches
   * again gets a new record rather than overwriting its earlier visit.
   */
  const record = (run: ActiveRun, step: GraphRunStep): void => {
    const last = run.steps.at(-1);
    if (
      last !== undefined &&
      last.outcome === 'running' &&
      last.nodeId === step.nodeId &&
      last.attempt === step.attempt
    ) {
      run.steps[run.steps.length - 1] = step;
    } else {
      run.steps.push(step);
    }
  };

  return {
    async load(): Promise<void> {
      const swept = await failRunningRuns(database, clock.now(), RESTART_REASON);
      if (swept > 0)
        logger.warn('runs left in flight by the previous process were ended', { swept });
      else logger.info('no run was in flight at the last stop');
    },

    async start(nodeId: NodeId, input: RouteInput): Promise<RunStarted> {
      if (stopped) return refused('the hub is stopping');
      const held = byGraph.get(nodeId);
      if (held !== undefined) {
        return refused(
          held === null
            ? 'a run of this graph is already starting'
            : `run #${String(held.number)} of this graph is still in flight; cancel it or wait for it to end`,
        );
      }
      if (byGraph.size >= GRAPH_RUNS_MAX_ACTIVE) {
        return refused(
          `this hub is running ${String(GRAPH_RUNS_MAX_ACTIVE)} graphs at once, the most it runs; wait for one to end`,
        );
      }
      // Reserved before the first await, so a second start of this graph in
      // the same tick is refused above rather than numbered beside this one.
      byGraph.set(nodeId, null);

      let run: ActiveRun;
      let document;
      let project: NodeId | null;
      try {
        project = await graphs.projectOf(nodeId);
        if (project === null) {
          byGraph.delete(nodeId);
          return refused('this hub has no graph by that id');
        }
        const published = await graphs.latestPublished(nodeId);
        if (published === null) {
          byGraph.delete(nodeId);
          return refused('this graph has no published version to run; publish it first');
        }
        // Checked again after every await: stop() cancels the runs it finds
        // in `active`, and a run that joined after it looked would be walked
        // by nobody's stop into a database being closed.
        if (stopped) {
          byGraph.delete(nodeId);
          return refused('the hub is stopping');
        }
        const { runId, number } = await insertRun(database, ids, clock, {
          graphNodeId: nodeId,
          version: published.version,
          input,
        });
        if (stopped) {
          byGraph.delete(nodeId);
          logger.info('a run was numbered as the hub stopped; the next boot sweeps its row', {
            runId,
          });
          return refused('the hub is stopping');
        }
        document = published.document;
        run = {
          nodeId,
          runId,
          number,
          of: document.nodes.length,
          step: 0,
          steps: [],
          walk: null,
          pending: null,
          writes: Promise.resolve(),
        };
        logger.info('run started', { nodeId, runId, number, version: published.version });
      } catch (error) {
        byGraph.delete(nodeId);
        throw error;
      }
      active.set(run.runId, run);
      byGraph.set(nodeId, run);
      publish(run, stateOf(run, 'running', null));

      const walking = walk(document, input, {
        executors: {
          trigger: triggerExecutor,
          router: routerExecutor,
          agent: agent.forProject(project),
        },
        timers,
        onStep: (step, reached) => {
          record(run, step);
          run.step = reached;
          const steps = [...run.steps];
          write(run, 'steps', () => replaceSteps(database, run.runId, steps));
          publish(run, stateOf(run, 'running', null));
        },
        onEnd: (outcome) => {
          const reason = outcome.status === 'failed' ? outcome.reason : null;
          active.delete(run.runId);
          byGraph.delete(nodeId);
          const final = stateOf(run, outcome.status, reason);
          publish(run, final);
          if (stopped) {
            logger.info('run ended after the stop; the next boot sweeps its row', {
              runId: run.runId,
            });
            return;
          }
          ending.set(nodeId, final);
          const endedAt = clock.now();
          write(run, 'end', () =>
            endRun(database, run.runId, {
              status: outcome.status,
              reason,
              steps: final.steps,
              endedAt,
            }),
          );
          void run.writes.then(() => {
            if (ending.get(nodeId) === final) ending.delete(nodeId);
            logger.info('run ended', {
              runId: run.runId,
              number: run.number,
              status: outcome.status,
              reason,
            });
          });
        },
      });
      run.walk = walking;

      return { ok: true, runId: run.runId, number: run.number };
    },

    async cancel(runId: GraphRunId): Promise<RunCancelled> {
      const run = active.get(runId);
      if (run !== undefined && run.walk !== null) {
        logger.info('run cancel asked', { runId, number: run.number });
        run.walk.cancel();
        return { ok: true };
      }
      for (const ended of ending.values()) {
        if (ended.runId === runId) {
          return refused(`run #${String(ended.number)} has already ended`);
        }
      }
      return refused('no run by that id is in flight');
    },

    async latest(nodeId: NodeId): Promise<GraphRunState | null> {
      const held = byGraph.get(nodeId);
      if (held !== undefined && held !== null) return stateOf(held, 'running', null);
      const ended = ending.get(nodeId);
      if (ended !== undefined) return ended;
      const row = await latestRun(database, nodeId);
      if (row === null) return null;
      // `of` is the version's node count, and the version may not be the
      // newest one any more: read the one the run was of.
      const document = await graphs.publishedVersion(nodeId, row.version);
      return fromRow(row, document?.nodes.length ?? 0);
    },

    noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): void {
      agent.noteStarts(storeId, starts);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      const walking = [...active.values()];
      for (const run of walking) run.walk?.cancel();
      logger.info('graph runs stopped', { cancelled: walking.length });
    },
  };
}
