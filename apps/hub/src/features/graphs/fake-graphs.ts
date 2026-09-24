import {
  emptyGraphDocument,
  nodeIdSchema,
  type GraphDocument,
  type GraphPublishedVersion,
  type NodeId,
} from '@agentplex/protocol';
import type { GraphCreated, GraphOpened, GraphPublished, Graphs, GraphSaved } from './graphs.js';

/**
 * The hub's graphs, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-docs.ts` is one: what a client connection has to get right is what it
 * does with an outcome -- a node id, a refusal in words, a document with its
 * version numbers -- and each of those is a value this hands back. The rows
 * and the publish rules are tested where they live.
 *
 * It keeps the draft-and-versions shape the real feature has, because the
 * frames a connection answers with read those numbers off the outcome, and a
 * fake that answered `version: 1` forever would pass a test that the real
 * feature fails.
 */
export interface FakeGraphs extends Graphs {
  /** Every create asked for, in order. */
  readonly created: readonly { nodeId: NodeId; projectId: NodeId; name: string }[];
  /** Every save asked for, in order. */
  readonly saved: readonly { nodeId: NodeId; document: GraphDocument }[];
  /** Every publish asked for, in order. */
  readonly publishes: readonly NodeId[];
  /** Every open asked for, in order. */
  readonly opened: readonly NodeId[];
  /** What every later call answers with, in place of the held graphs. */
  refuseWith(refusal: { code: 'refused' | 'internal'; problem: string } | null): void;
  /** Puts a graph in this fake without going through `create`. */
  hold(graph: { nodeId: NodeId; projectId: NodeId; name: string; document?: GraphDocument }): void;
}

export interface FakeGraphsOptions {
  /** What a save reports back as the moment it landed. */
  readonly updatedAt?: number;
}

interface Held {
  readonly nodeId: NodeId;
  readonly projectId: NodeId;
  readonly name: string;
  draft: GraphDocument;
  draftVersion: number;
  readonly published: { version: number; publishedAt: number; document: GraphDocument }[];
}

export function createFakeGraphs(options: FakeGraphsOptions = {}): FakeGraphs {
  const created: { nodeId: NodeId; projectId: NodeId; name: string }[] = [];
  const saved: { nodeId: NodeId; document: GraphDocument }[] = [];
  const publishes: NodeId[] = [];
  const opened: NodeId[] = [];
  const held = new Map<NodeId, Held>();
  let updatedAt = options.updatedAt ?? 1_756_000_000_000;
  let refusal: { code: 'refused' | 'internal'; problem: string } | null = null;
  let minted = 0;

  const missing = {
    ok: false,
    code: 'refused',
    problem: 'this hub has no graph by that id',
  } as const;

  return {
    async create(projectId: NodeId, name: string): Promise<GraphCreated> {
      if (refusal !== null) return { ok: false, ...refusal };
      const nodeId = nodeIdSchema.parse(`graph-${String((minted += 1))}`);
      held.set(nodeId, {
        nodeId,
        projectId,
        name,
        draft: emptyGraphDocument(),
        draftVersion: 1,
        published: [],
      });
      created.push({ nodeId, projectId, name });
      return { ok: true, nodeId };
    },

    async open(nodeId: NodeId): Promise<GraphOpened> {
      opened.push(nodeId);
      if (refusal !== null) return { ok: false, ...refusal };
      const graph = held.get(nodeId);
      if (graph === undefined) return missing;
      return {
        ok: true,
        nodeId,
        name: graph.name,
        draftVersion: graph.draftVersion,
        document: graph.draft,
        published: graph.published.map((row): GraphPublishedVersion => ({
          version: row.version,
          publishedAt: row.publishedAt,
        })),
      };
    },

    async save(nodeId: NodeId, document: GraphDocument): Promise<GraphSaved> {
      saved.push({ nodeId, document });
      if (refusal !== null) return { ok: false, ...refusal };
      const graph = held.get(nodeId);
      if (graph === undefined) return missing;
      graph.draft = document;
      updatedAt += 1;
      return { ok: true, version: graph.draftVersion, updatedAt };
    },

    async publish(nodeId: NodeId): Promise<GraphPublished> {
      publishes.push(nodeId);
      if (refusal !== null) return { ok: false, ...refusal };
      const graph = held.get(nodeId);
      if (graph === undefined) return missing;
      const version = graph.draftVersion;
      graph.published.push({ version, publishedAt: updatedAt, document: graph.draft });
      graph.draftVersion += 1;
      return { ok: true, version };
    },

    async publishedVersion(nodeId: NodeId, version: number): Promise<GraphDocument | null> {
      const graph = held.get(nodeId);
      return graph?.published.find((row) => row.version === version)?.document ?? null;
    },

    refuseWith(next: { code: 'refused' | 'internal'; problem: string } | null): void {
      refusal = next;
    },

    hold(graph: {
      nodeId: NodeId;
      projectId: NodeId;
      name: string;
      document?: GraphDocument;
    }): void {
      held.set(graph.nodeId, {
        nodeId: graph.nodeId,
        projectId: graph.projectId,
        name: graph.name,
        draft: graph.document ?? emptyGraphDocument(),
        draftVersion: 1,
        published: [],
      });
    },

    get created() {
      return created;
    },
    get saved() {
      return saved;
    },
    get publishes() {
      return publishes;
    },
    get opened() {
      return opened;
    },
  };
}
