import {
  assertNever,
  evaluateRouteCondition,
  GRAPH_NODES_MAX,
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  graphIncoming,
  parseRouteCondition,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type GraphNodeKind,
  type GraphRunChild,
  type GraphRunStep,
  type GraphRunStepOutput,
  type RouteInput,
} from '@agentplex/protocol';
import type { Timers } from '@agentplex/node-shared';

/**
 * The walk: from the TRIGGER, node after node down every branch, until no
 * branch has anywhere to go, with each node's work handed to an executor for
 * its kind.
 *
 * ## Pure, and everything injected
 *
 * Nothing here reaches a database, a machine or a clock. The executors are a
 * table this is given, the backoff waits through injected timers, and every
 * step is reported through a callback. That is what makes the traversal, the
 * retry and the cancel a unit test each: the AGENT executor that actually
 * starts a session is `agent-executor.ts`, tested against its own seams, and
 * the walk is tested with one that answers what it is told.
 *
 * ## The table is typed by kind, minus the one kind nothing runs
 *
 * `ExecutorTable` is `Record` over every kind but `action`. Publish refuses
 * an ACTION node, since no build performs one, so a run reaching one is a
 * document that bypassed publish; it fails with a sentence naming the node,
 * from a switch that ends in `assertNever` -- so an eighth kind added to the
 * protocol is a type error here and not a silent fall through. The one table
 * that answers ACTION is a simulation's (`simulate.ts`), which walks the same
 * traversal with executors that report and do nothing.
 *
 * A SUB-GRAPH is an executor like any other: it runs a whole walk of another
 * graph and answers when that walk ends. The walk here knows nothing of
 * that except the child's name, which the executor hands over through
 * `StepContext.child` the moment the child is numbered, and which every
 * record of that attempt then carries -- the running one re-reported with it,
 * and the outcome. A retry is a new attempt and so a new child, which is what
 * lets a person see which try of the lint suite broke and open that one.
 *
 * ## Branches, and the JOIN
 *
 * A node that is not a ROUTER goes on down every edge out of it. One edge is
 * the walk carrying on; several are a fan-out, and each is a branch of its
 * own, walked at the same time as the others. A branch ends at a node with
 * nowhere to go, or at a JOIN that is still waiting on another branch: the
 * JOIN holds each arrival under the node it came from, and the branch that
 * brings the last one goes on through it with `{ branches: { [from]: output
 * } }`. A JOIN one of whose branches never came -- a ROUTER upstream sent the
 * run elsewhere -- fails the run when nothing else is left to walk, naming the
 * join and the branch, rather than a run that sits forever.
 *
 * The run ends when its last branch does. One branch left at a node with
 * nowhere to go hands on what it carried, as a run always has; several hand
 * on each under its node, in the shape a JOIN would.
 *
 * `reached` is one counter for the run, however many branches add to it, so
 * the bound that stops a loop is the same bound for a run that fans out.
 *
 * A simulation walks the branches `in-turn`: one after another in the order
 * they were reached, so the path it answers with reads in a stable order and
 * a SUB-GRAPH's child steps still follow the step that reached them.
 *
 * ## A step is one attempt
 *
 * Every attempt at a node is reported twice: once as `running` when it begins
 * and once with what it became, the same `nodeId` and `attempt` on both, so
 * whoever keeps the list replaces a running record with its outcome rather
 * than holding a step that is forever running beside the one that ended.
 * Branches interleave, so the outcome is not always the record directly after
 * its running one: the open record with the same node and attempt is the one
 * to replace. Retries are further attempts of the same node, one wait apart.
 * A node reached twice, through a cycle, is two runs of records: the list is
 * the walk in order, not a table by node.
 *
 * ## What a step hands on is not what it records
 *
 * A result has two outputs. `carried` is the route input the next node is
 * given -- what a ROUTER's conditions read -- and it may be as wide as a route
 * input is allowed to be. `output` is what the step record says about it, in
 * the bounded shape the protocol fixes per kind of node, and it is the only
 * one of the two that leaves this process. The end of the run is reported
 * through `onEnd` synchronously, before `done` resolves, so that whoever
 * publishes the steps can fold the end into the same change as the last
 * step's outcome instead of sending the list twice.
 *
 * A step that stops to ask a person is reported a third time, as `waiting`,
 * between those two. The executor says when, through `StepContext.waiting`,
 * because only it knows the moment the request left; the walk records it, so
 * that the run's status can say `waiting` off the same list everything else
 * is read from rather than off a second flag.
 *
 * ## Cancel stops before the next step, and so does a failing branch
 *
 * A cancel does not interrupt the step in flight. An agent mid-turn is the
 * case a stop refuses to touch, for the reason `routeStop` gives -- an edit
 * half applied -- and the same reason holds here. What a cancel does is tell
 * every executor in flight (which may stop early if it can), cancel any
 * backoff wait, and end the run `cancelled` once the steps in flight have
 * ended, before any next node is reached.
 *
 * A branch that fails does the same to its siblings -- there is no run left
 * for them to finish -- and the run then ends `failed` with the failing
 * branch's sentence, not `cancelled`: the executors are told through the
 * one `halt` both fire, and only the run's own cancel makes the end say so.
 */

/**
 * What one attempt at a node produced.
 *
 * `carried` is handed to the next node; `output` is recorded on the step, or
 * `null` when the step has nothing worth a record. `next` is the node the run
 * goes to, or `null` to follow every edge out of the node. Only a ROUTER
 * ever names one: its routes are the choice, and the walk following an edge
 * on its behalf would be a second reading of the same decision.
 *
 * A failure is retried by the node's policy unless it says `retryable:
 * false`: a failure that is a decision rather than a fault -- a person's Deny,
 * a timeout nobody answered -- ends the run at that node, because asking
 * again is overruling the answer. Absent means retryable, which is what every
 * fault an executor meets is.
 */
export type StepResult =
  | {
      readonly ok: true;
      readonly carried: RouteInput;
      readonly output: GraphRunStepOutput | null;
      readonly next: GraphNodeId | null;
    }
  | { readonly ok: false; readonly problem: string; readonly retryable?: false };

/** How a step learns that the run was cancelled under it. */
export interface Cancellation {
  readonly cancelled: boolean;
  /** Calls `listener` once, on cancel, or immediately if already cancelled. Returns the detach. */
  onCancel(listener: () => void): () => void;
}

export interface StepContext {
  readonly document: GraphDocument;
  /** Counts from 0: the first try of a node is attempt 0. */
  readonly attempt: number;
  readonly cancellation: Cancellation;
  /**
   * Says this attempt is now waiting on a person. The walk records a
   * `waiting` step for it; calling it twice records it twice, which whoever
   * keeps the list collapses.
   */
  waiting(): void;
  /**
   * Names the run this attempt started, for a SUB-GRAPH. The walk records
   * the running step again with the child on it, and every later record of
   * this attempt carries it too.
   */
  child(child: GraphRunChild): void;
}

export type Executor<K extends GraphNodeKind> = (
  node: Extract<GraphNode, { kind: K }>,
  input: RouteInput,
  context: StepContext,
) => Promise<StepResult>;

/** The kinds this runtime executes: every one but ACTION, which publish refuses. JOIN included: its step is the walk going through it. */
export type ExecutableKind = Exclude<GraphNodeKind, 'action'>;

export type ExecutorTable = { readonly [K in ExecutableKind]: Executor<K> };

/**
 * A table that may also answer for ACTION. Only a simulation passes one: it
 * walks every kind, ACTION included, by reporting what the node would do and
 * doing nothing, and it reuses this walk rather than keeping a second
 * traversal that could come to disagree with the one a run takes. A run's
 * table has no ACTION entry, and the walk then fails the node as before.
 */
export type WalkTable = ExecutorTable & { readonly action?: Executor<'action'> };

/**
 * How a walk ended. A failure carries `retryable: false` when the node that
 * ended it failed on a decision rather than a fault, so a SUB-GRAPH step whose
 * child this walk is passes the same answer up instead of retrying it.
 */
export type WalkOutcome =
  | { readonly status: 'succeeded'; readonly output: RouteInput }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable?: false }
  | { readonly status: 'cancelled' };

export interface WalkDependencies {
  readonly executors: WalkTable;
  /** What a backoff waits on. Injected so a retry schedule is a value a test reads. */
  readonly timers: Timers;
  /**
   * Called for every step record, with how many nodes the run has reached so
   * far -- the `step` of `step 3/9`.
   */
  readonly onStep: (step: GraphRunStep, reached: number) => void;
  /**
   * Called once, synchronously, with how the run ended, after the last
   * `onStep` and before `done` resolves.
   */
  readonly onEnd: (outcome: WalkOutcome) => void;
  /**
   * How a fan-out's branches are walked: `together` (the default), each at
   * once, as a run walks them; or `in-turn`, one after another in the order
   * they were reached, as a simulation does so its path reads in order.
   */
  readonly branches?: 'together' | 'in-turn';
}

export interface Walk {
  readonly done: Promise<WalkOutcome>;
  /** Stops the run before its next step. Calling it twice does nothing the second time. */
  cancel(): void;
}

/** What to call a node in a sentence: its label, or its id when it has none. */
export function nameOf(node: GraphNode): string {
  return node.label.trim().length > 0 ? node.label : node.id;
}

/** The kind in the capitals the canvas letters it in. */
export const KIND_WORDS: Record<GraphNodeKind, string> = {
  trigger: 'TRIGGER',
  router: 'ROUTER',
  agent: 'AGENT',
  subgraph: 'SUB-GRAPH',
  human: 'HUMAN',
  action: 'ACTION',
  join: 'JOIN',
};

/**
 * A TRIGGER passes the run input on, and records it as text cut at the
 * output bound. Where a run starts, and nothing else.
 */
export const triggerExecutor: Executor<'trigger'> = async (_node, input) => ({
  ok: true,
  carried: input,
  output: { kind: 'text', text: JSON.stringify(input).slice(0, GRAPH_RUN_OUTPUT_MAX_CHARS) },
  next: null,
});

/**
 * A JOIN hands on what the walk gathered for it -- every incoming branch's
 * output under the node it came from -- and records nothing of it: the
 * branches' own steps already say what each made.
 */
export const joinExecutor: Executor<'join'> = async (_node, input) => ({
  ok: true,
  carried: input,
  output: null,
  next: null,
});

/**
 * A ROUTER picks the first route whose condition holds against its input,
 * else `otherwise`, else fails naming itself. It hands its input on unchanged
 * -- a router decides where the run goes and changes nothing on the way -- and
 * records the choice: the index of the route that held, or `null` for
 * `otherwise`, and the node it led to.
 */
export const routerExecutor: Executor<'router'> = async (node, input) => {
  for (const [index, route] of node.routes.entries()) {
    const parsed = parseRouteCondition(route.condition);
    if (!parsed.ok) {
      return {
        ok: false,
        problem: `the condition ${JSON.stringify(route.condition)} on ${nameOf(node)} does not parse: ${parsed.problem}`,
      };
    }
    if (evaluateRouteCondition(parsed.condition, input)) {
      return {
        ok: true,
        carried: input,
        output: { kind: 'route', route: index, to: route.to },
        next: route.to,
      };
    }
  }
  if (node.otherwise !== null) {
    return {
      ok: true,
      carried: input,
      output: { kind: 'route', route: null, to: node.otherwise },
      next: node.otherwise,
    };
  }
  return { ok: false, problem: `no route on ${nameOf(node)} matched and it has no otherwise` };
};

/**
 * The executor for a node, or `null` for a kind this runtime does not run:
 * ACTION, unless the table is a simulation's.
 *
 * A switch and not an index, so that the kinds with no executor are named
 * here and a kind nobody has heard of is a type error at the `assertNever`.
 */
function executorFor(
  table: WalkTable,
  node: GraphNode,
): ((input: RouteInput, context: StepContext) => Promise<StepResult>) | null {
  switch (node.kind) {
    case 'trigger':
      return (input, context) => table.trigger(node, input, context);
    case 'router':
      return (input, context) => table.router(node, input, context);
    case 'agent':
      return (input, context) => table.agent(node, input, context);
    case 'human':
      return (input, context) => table.human(node, input, context);
    case 'subgraph':
      return (input, context) => table.subgraph(node, input, context);
    case 'join':
      return (input, context) => table.join(node, input, context);
    case 'action': {
      const action = table.action;
      return action === undefined ? null : (input, context) => action(node, input, context);
    }
    default:
      return assertNever(node, 'graph node kind');
  }
}

function createCancellation(): Cancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled(): boolean {
      return cancelled;
    },
    onCancel(listener: () => void): () => void {
      if (cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

export function walk(
  document: GraphDocument,
  input: RouteInput,
  dependencies: WalkDependencies,
): Walk {
  const { executors, timers, onStep, onEnd } = dependencies;
  const inTurn = dependencies.branches === 'in-turn';
  /** The run's own cancel: what `Walk.cancel` fires, and what makes the end `cancelled`. */
  const cancellation = createCancellation();
  /**
   * What every step and backoff is handed: fired by the run's cancel and by
   * the first branch that fails, so a failure stops its siblings the way a
   * cancel would -- while the end still says `failed`, because `halt` is not
   * what decides the end.
   */
  const halt = createCancellation();
  cancellation.onCancel(() => halt.cancel());
  const byId = new Map(document.nodes.map((node) => [node.id, node]));

  /** The first failure, which is the run's end; later ones are its siblings being stopped. */
  let failure: Extract<WalkOutcome, { status: 'failed' }> | null = null;
  /** Nodes reached across every branch: one counter, so the loop bound holds for the run. */
  let reached = 0;
  /** Branches started and not yet ended. The run ends when the last one does. */
  let live = 0;
  /** Branches waiting their turn, in the order they were reached; only `in-turn` queues. */
  const queue: { readonly node: GraphNode; readonly carried: RouteInput }[] = [];
  /** What a branch that ended at a node with nowhere to go carried out, by that node. */
  const leaves = new Map<GraphNodeId, RouteInput>();
  /** What has reached each JOIN so far, by the node it came from. */
  const arrivals = new Map<GraphNodeId, Map<GraphNodeId, RouteInput>>();

  let resolveDone: (outcome: WalkOutcome) => void = () => {};
  const done = new Promise<WalkOutcome>((resolve) => {
    resolveDone = resolve;
  });

  /**
   * Every exit goes through here, so the end is said in the same synchronous
   * stretch as the last step -- an `await` between them would be a microtask
   * in which the list is published without its end.
   */
  const end = (outcome: WalkOutcome): void => {
    onEnd(outcome);
    resolveDone(outcome);
  };

  /** Records the first failure and stops every other branch; a failure after a cancel is the cancel. */
  const fail = (reason: string, retryable?: false): void => {
    if (halt.cancelled) return;
    failure =
      retryable === false ? { status: 'failed', reason, retryable } : { status: 'failed', reason };
    halt.cancel();
  };

  /** Waits `ms`, or returns early with `false` when the run is halted meanwhile. */
  const wait = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (waited: boolean): void => {
        if (settled) return;
        settled = true;
        detach();
        cancelTimer();
        resolve(waited);
      };
      const cancelTimer = timers.schedule(ms, () => finish(true));
      const detach = halt.onCancel(() => finish(false));
    });

  /**
   * Where a run goes after a node: the one node a ROUTER named, or every node
   * an edge leads to, each once, in the order the edges are listed. More than
   * one is a fan-out; none is the end of this branch.
   */
  const nextOf = (
    node: GraphNode,
    result: Extract<StepResult, { ok: true }>,
  ): { readonly next: readonly GraphNode[] } | { readonly problem: string } => {
    if (result.next !== null) {
      const named = byId.get(result.next);
      if (named === undefined) {
        return { problem: `${nameOf(node)} routed to ${result.next}, which is no node here` };
      }
      return { next: [named] };
    }
    const next: GraphNode[] = [];
    for (const edge of document.edges) {
      if (edge.from !== node.id) continue;
      // The schema refused any edge to a node that is not there.
      const target = byId.get(edge.to);
      if (target !== undefined && !next.includes(target)) next.push(target);
    }
    return { next };
  };

  /**
   * A branch reaching a JOIN: its output is held under the node it came
   * from, and the join goes on -- with every branch's output -- only once
   * each node `graphIncoming` names has arrived. `null` while any is still out.
   */
  const arrive = (join: GraphNode, from: GraphNodeId, carried: RouteInput): RouteInput | null => {
    const expected = graphIncoming(document, join.id);
    const held = arrivals.get(join.id) ?? new Map<GraphNodeId, RouteInput>();
    held.set(from, carried);
    if (expected.some((id) => !held.has(id))) {
      arrivals.set(join.id, held);
      return null;
    }
    arrivals.delete(join.id);
    const branches: Record<string, RouteInput> = {};
    for (const id of expected) {
      const output = held.get(id);
      if (output !== undefined) branches[id] = output;
    }
    return { branches };
  };

  /** How the run ended, once no branch is left: said once, synchronously. */
  const finish = (): void => {
    if (failure !== null) return end(failure);
    if (cancellation.cancelled) return end({ status: 'cancelled' });
    for (const [joinId, held] of arrivals) {
      const join = byId.get(joinId);
      if (join === undefined) continue;
      const missing = graphIncoming(document, joinId)
        .filter((id) => !held.has(id))
        .map((id) => {
          const source = byId.get(id);
          return source === undefined ? id : nameOf(source);
        });
      return end({
        status: 'failed',
        reason: `the JOIN node ${nameOf(join)} waits for every incoming branch, and ${missing.join(' and ')} never reached it`,
      });
    }
    // One leaf hands on what it carried, as a run always has; several hand
    // on each under its node, in the document's order, as a JOIN would.
    const ended = document.nodes.filter((node) => leaves.has(node.id));
    const [single, ...more] = ended;
    const only = single !== undefined && more.length === 0 ? leaves.get(single.id) : undefined;
    if (only !== undefined) return end({ status: 'succeeded', output: only });
    const branches: Record<string, RouteInput> = {};
    for (const node of ended) {
      const output = leaves.get(node.id);
      if (output !== undefined) branches[node.id] = output;
    }
    return end({ status: 'succeeded', output: ended.length === 0 ? input : { branches } });
  };

  /** A branch has ended: start the next in turn, or end the run when none is left. */
  const branchEnded = (): void => {
    live -= 1;
    const next = queue.shift();
    if (next !== undefined && !halt.cancelled) {
      start(next.node, next.carried);
      return;
    }
    queue.length = 0;
    if (live === 0) finish();
  };

  /** Starts a branch now, or queues it behind the one walking when branches take turns. */
  const spawn = (node: GraphNode, carried: RouteInput): void => {
    if (inTurn) queue.push({ node, carried });
    else start(node, carried);
  };

  const start = (node: GraphNode, carried: RouteInput): void => {
    live += 1;
    void branch(node, carried);
  };

  /** How to record a step of one attempt at one node, with the child it named if any. */
  type Recorder = (outcome: GraphRunStep['outcome'], output: GraphRunStepOutput | null) => void;

  /**
   * One attempt at a node: records it running, runs it, and answers what it
   * became with the recorder for its outcome. The outcome is recorded by the
   * caller, so that the record and whatever the branch does next -- the next
   * node's start, or the run's end -- are one synchronous stretch.
   */
  async function attemptAt(
    node: GraphNode,
    execute: (input: RouteInput, context: StepContext) => Promise<StepResult>,
    carried: RouteInput,
    attempt: number,
  ): Promise<{ readonly attempted: StepResult; readonly record: Recorder }> {
    // The child this attempt started, once the executor names one.
    let child: GraphRunChild | null = null;
    const record: Recorder = (outcome, output) =>
      onStep({ nodeId: node.id, attempt, outcome, output, child }, reached);
    record('running', null);
    try {
      const attempted = await execute(carried, {
        document,
        attempt,
        cancellation: halt,
        waiting: () => record('waiting', null),
        child: (named) => {
          child = named;
          record('running', null);
        },
      });
      return { attempted, record };
    } catch (error) {
      return { attempted: { ok: false, problem: String(error) }, record };
    }
  }

  /** The sentence a run ends with when a node has failed for the last time. */
  function failedWords(
    node: GraphNode,
    attempt: number,
    attempted: { problem: string; retryable?: false },
  ): string {
    const named = `the ${KIND_WORDS[node.kind]} node ${nameOf(node)}`;
    if (attempt === 0) return `${named} failed: ${attempted.problem}`;
    if (attempted.retryable === false) {
      return `${named} failed on attempt ${String(attempt + 1)}, and not for a reason another try changes: ${attempted.problem}`;
    }
    return `${named} failed on all ${String(attempt + 1)} attempts; the last said: ${attempted.problem}`;
  }

  /**
   * Every attempt at a node its retry policy allows, until one ends it: one
   * that succeeded, one that failed for the last time, one the halt reached,
   * or a backoff the halt cut short. The last attempt's outcome is left for
   * the branch to record, after the last `await` here, so that record and
   * what the branch does next -- the next node's start, or the run's end --
   * are one synchronous stretch and whoever publishes them sends one change.
   */
  async function attempts(
    node: GraphNode,
    execute: (input: RouteInput, context: StepContext) => Promise<StepResult>,
    carried: RouteInput,
  ): Promise<
    | {
        readonly ended: 'succeeded';
        readonly result: Extract<StepResult, { ok: true }>;
        readonly record: Recorder;
      }
    | {
        readonly ended: 'failed';
        readonly reason: string;
        readonly retryable?: false;
        readonly record: Recorder;
      }
    | { readonly ended: 'halted'; readonly record: Recorder | null }
  > {
    for (let attempt = 0; ; attempt += 1) {
      const { attempted, record } = await attemptAt(node, execute, carried, attempt);
      if (attempted.ok) return { ended: 'succeeded', result: attempted, record };
      // A failure while halted is the halt arriving, not the node failing:
      // the step is marked as what happened to it, and the branch ends
      // without another try.
      if (halt.cancelled) return { ended: 'halted', record };
      if (attempt >= node.retry.max || attempted.retryable === false) {
        const reason = failedWords(node, attempt, attempted);
        return attempted.retryable === false
          ? { ended: 'failed', reason, retryable: false, record }
          : { ended: 'failed', reason, record };
      }
      record('failed', null);
      const waited = await wait(node.retry.backoff * 1_000);
      if (!waited) return { ended: 'halted', record: null };
    }
  }

  /**
   * One branch: node after node until it reaches a node with nowhere to go,
   * a JOIN still waiting on another branch, a fan-out (whose branches it
   * starts and then ends), a failure, or the halt. `branchEnded` is called in
   * the `finally`, synchronously at the branch's last step, so the run's end
   * is said in the same stretch as that step.
   */
  async function branch(first: GraphNode, firstCarried: RouteInput): Promise<void> {
    let node = first;
    let carried = firstCarried;
    try {
      for (;;) {
        if (halt.cancelled) return;
        reached += 1;
        if (reached > GRAPH_NODES_MAX) {
          fail(
            `the run reached ${nameOf(node)} as its ${String(reached)}th step, more nodes than a graph holds, so it is looping`,
          );
          return;
        }

        const execute = executorFor(executors, node);
        if (execute === null) {
          fail(
            `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} is a kind this runtime cannot execute yet`,
          );
          return;
        }

        const tried = await attempts(node, execute, carried);
        if (tried.ended === 'halted') {
          tried.record?.('cancelled', null);
          return;
        }
        if (tried.ended === 'failed') {
          tried.record('failed', null);
          fail(tried.reason, tried.retryable);
          return;
        }
        const result = tried.result;
        tried.record('succeeded', result.output);
        carried = result.carried;
        if (halt.cancelled) return;

        const followed = nextOf(node, result);
        if ('problem' in followed) {
          fail(followed.problem);
          return;
        }
        if (followed.next.length === 0) {
          leaves.set(node.id, carried);
          return;
        }

        const going: { readonly node: GraphNode; readonly carried: RouteInput }[] = [];
        for (const next of followed.next) {
          if (next.kind !== 'join') {
            going.push({ node: next, carried });
            continue;
          }
          const merged = arrive(next, node.id, carried);
          if (merged !== null) going.push({ node: next, carried: merged });
        }
        const [only, ...others] = going;
        if (only === undefined) return;
        if (others.length > 0) {
          // A fan-out: each branch its own, started in the order the edges
          // are listed, and this one ends here.
          for (const each of going) spawn(each.node, each.carried);
          return;
        }
        node = only.node;
        carried = only.carried;
      }
    } catch (error) {
      fail(`the walk broke at ${nameOf(node)}: ${String(error)}`);
    } finally {
      branchEnded();
    }
  }

  const triggers = document.nodes.filter((node) => node.kind === 'trigger');
  const trigger = triggers[0];
  if (trigger === undefined || triggers.length !== 1) {
    end({
      status: 'failed',
      reason: `a run starts at the one TRIGGER node, and this document has ${String(triggers.length)}`,
    });
  } else {
    start(trigger, input);
  }

  return { done, cancel: () => cancellation.cancel() };
}
