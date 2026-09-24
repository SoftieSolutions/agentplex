import { beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type GraphDocument,
  type GraphNode,
  type GraphRunChild,
  type NodeId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import {
  createSubgraphExecutor,
  SUBGRAPH_DEPTH_LIMIT,
  type ChildLaunch,
  type ChildLaunched,
  type LineageEntry,
  type SubgraphExecutor,
} from './subgraph-executor.js';
import type { Cancellation, StepContext, WalkOutcome } from './walker.js';

/**
 * The SUB-GRAPH step: resolve the pin, refuse a chain that reaches itself or
 * goes too deep, start the child through the one seam that makes runs, and
 * answer when the child ends.
 *
 * The seam that starts a child is hand-written here, because what this file
 * is about is what the step decides and says -- which document, which parent,
 * which refusal, what a child's end becomes -- and not how a run is numbered,
 * written or published. That is `graph-runs.test.ts`'s subject, which drives
 * this executor through the real feature.
 */

const logger = createLogger('error', () => {});
const PARENT_RUN = graphRunIdSchema.parse('run-parent');
const RELEASE = nodeIdSchema.parse('graph-release');
const LINT = nodeIdSchema.parse('graph-lint');

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' };

const PARENT_DOC: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    { ...BASE, id: 'lint', kind: 'subgraph', label: 'Lint suite', graph: LINT, version: 3 },
    { ...BASE, id: 'self', kind: 'subgraph', label: 'Again', graph: RELEASE, version: 1 },
  ],
  edges: [{ from: 'start', to: 'lint' }],
});
const CHILD_DOC: GraphDocument = graphDocumentSchema.parse({ nodes: [TRIGGER], edges: [] });

function subgraphNode(id: string): Extract<GraphNode, { kind: 'subgraph' }> {
  const node = PARENT_DOC.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || node.kind !== 'subgraph') throw new Error(`no SUB-GRAPH node ${id}`);
  return node;
}

function fakeCancellation(): Cancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A child the test ends by hand, recording whether it was told to stop. */
interface HeldChild {
  readonly request: ChildLaunch;
  cancelled: boolean;
  end(outcome: WalkOutcome): void;
}

let launched: HeldChild[];
let pinsAsked: { graph: NodeId; version: number }[];
let refuseLaunchWith: string | null;
let children: GraphRunChild[];
let cancellation: Cancellation & { cancel(): void };

function executor(): SubgraphExecutor {
  return createSubgraphExecutor({
    graphs: {
      publishedVersion: async (graph, version) => {
        pinsAsked.push({ graph, version });
        return version === 3 || (graph === RELEASE && version === 1) ? CHILD_DOC : null;
      },
    },
    launch: async (request): Promise<ChildLaunched> => {
      if (refuseLaunchWith !== null) return { ok: false, problem: refuseLaunchWith };
      let finish: (outcome: WalkOutcome) => void = () => {};
      const done = new Promise<WalkOutcome>((resolve) => {
        finish = resolve;
      });
      const held: HeldChild = { request, cancelled: false, end: (outcome) => finish(outcome) };
      launched.push(held);
      return {
        ok: true,
        child: {
          runId: graphRunIdSchema.parse(`child-${String(launched.length)}`),
          number: 40 + launched.length,
          name: 'lint-suite',
          done,
          cancel: () => {
            held.cancelled = true;
            finish({ status: 'cancelled' });
          },
        },
      };
    },
    logger,
  });
}

function context(): StepContext {
  return {
    document: PARENT_DOC,
    attempt: 0,
    cancellation,
    waiting: () => {},
    child: (named) => children.push(named),
  };
}

const ROOT: readonly LineageEntry[] = [{ graph: RELEASE, name: 'release-pipeline' }];

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('the SUB-GRAPH executor', () => {
  beforeEach(() => {
    launched = [];
    pinsAsked = [];
    refuseLaunchWith = null;
    children = [];
    cancellation = fakeCancellation();
  });

  it('resolves the pin, starts the child at that version under this step, and names it', async () => {
    const step = executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('lint'),
      { language: 'rust' },
      context(),
    );
    await settle();

    expect(pinsAsked).toEqual([{ graph: LINT, version: 3 }]);
    expect(launched.map((held) => held.request)).toEqual([
      {
        graph: LINT,
        version: 3,
        document: CHILD_DOC,
        input: { language: 'rust' },
        parent: { runId: PARENT_RUN, nodeId: 'lint' },
        lineage: ROOT,
      },
    ]);
    // Named the moment it was numbered, before it ends.
    expect(children).toEqual([{ runId: 'child-1', number: 41 }]);

    launched[0]?.end({ status: 'succeeded', output: { language: 'rust', clean: true } });

    await expect(step).resolves.toEqual({
      ok: true,
      carried: { language: 'rust', clean: true },
      output: null,
      next: null,
    });
  });

  it('fails naming the node when the pin is no published version', async () => {
    const node = { ...subgraphNode('lint'), version: 9 };

    const result = await executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      node,
      {},
      context(),
    );

    expect(result).toEqual({
      ok: false,
      problem: `it pins ${LINT} at v9, which is not a published version of any graph this hub has`,
    });
    expect(launched).toEqual([]);
  });

  it('refuses a chain that reaches a graph already on its stack, naming the node and the chain', async () => {
    const result = await executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('self'),
      {},
      context(),
    );

    expect(result).toEqual({
      ok: false,
      problem:
        'it would run release-pipeline, which is already running above it in this chain: release-pipeline → release-pipeline',
    });
    // Refused before anything is read or started.
    expect(pinsAsked).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('sees a cycle further up the stack than the parent', async () => {
    const lineage: readonly LineageEntry[] = [
      { graph: LINT, name: 'lint-suite' },
      { graph: RELEASE, name: 'release-pipeline' },
    ];

    const result = await executor().forRun({ runId: PARENT_RUN, lineage })(
      subgraphNode('lint'),
      {},
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      problem:
        'it would run lint-suite, which is already running above it in this chain: lint-suite → release-pipeline → lint-suite',
    });
  });

  it(`starts a child ${String(SUBGRAPH_DEPTH_LIMIT)} deep and refuses one deeper`, async () => {
    const chain = (length: number): LineageEntry[] =>
      Array.from({ length }, (_, index) => ({
        graph: nodeIdSchema.parse(`graph-${String(index)}`),
        name: `g${String(index)}`,
      }));

    // The root is depth 0, so a lineage of LIMIT graphs makes a child at depth LIMIT.
    void executor().forRun({ runId: PARENT_RUN, lineage: chain(SUBGRAPH_DEPTH_LIMIT) })(
      subgraphNode('lint'),
      {},
      context(),
    );
    await settle();
    expect(launched).toHaveLength(1);

    const deeper = await executor().forRun({
      runId: PARENT_RUN,
      lineage: chain(SUBGRAPH_DEPTH_LIMIT + 1),
    })(subgraphNode('lint'), {}, context());

    expect(deeper).toEqual({
      ok: false,
      problem: `it would start a run ${String(SUBGRAPH_DEPTH_LIMIT + 1)} graphs deep, and a chain of SUB-GRAPH nodes goes at most ${String(SUBGRAPH_DEPTH_LIMIT)}`,
    });
    expect(launched).toHaveLength(1);
  });

  it('fails with the child’s number and sentence when the child fails', async () => {
    const step = executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('lint'),
      {},
      context(),
    );
    await settle();

    launched[0]?.end({ status: 'failed', reason: 'no route on classify matched' });

    await expect(step).resolves.toEqual({
      ok: false,
      problem: 'run #41 of lint-suite failed: no route on classify matched',
    });
  });

  it('says the launch’s refusal, and names no child, when the child cannot start', async () => {
    refuseLaunchWith =
      'this hub is running 8 graphs at once, the most it runs; wait for one to end';

    const result = await executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('lint'),
      {},
      context(),
    );

    expect(result).toEqual({
      ok: false,
      problem: 'this hub is running 8 graphs at once, the most it runs; wait for one to end',
    });
    expect(children).toEqual([]);
  });

  it('cascades a cancel to the child, and the step ends when the child does', async () => {
    const step = executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('lint'),
      {},
      context(),
    );
    await settle();
    expect(launched[0]?.cancelled).toBe(false);

    cancellation.cancel();

    expect(launched[0]?.cancelled).toBe(true);
    await expect(step).resolves.toEqual({
      ok: false,
      problem: 'run #41 of lint-suite was cancelled',
    });
  });

  it('starts no child when the run was cancelled while the pin was being read', async () => {
    cancellation.cancel();

    const result = await executor().forRun({ runId: PARENT_RUN, lineage: ROOT })(
      subgraphNode('lint'),
      {},
      context(),
    );

    expect(result).toEqual({
      ok: false,
      problem: 'the run was cancelled before this step started its child',
    });
    expect(launched).toEqual([]);
  });
});
