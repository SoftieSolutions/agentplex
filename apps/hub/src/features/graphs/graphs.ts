import type {
  GraphDocument,
  GraphNode,
  GraphPublishedVersion,
  NodeId,
  RefusalCode,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import {
  insertGraph,
  listPublishedVersions,
  publishDraft,
  readDraft,
  readGraph,
  readVersion,
  replaceDraft,
} from './graph-rows.js';

/**
 * Graphs, from the hub's side: the rows, and the rules that make a version.
 *
 * A graph is the one kind of content the hub holds itself -- 0017 argues why
 * -- so everything here is a read or a write of this hub's own rows and no
 * machine is asked anything. That is the whole difference from the documents
 * feature this is modelled on, and it is why there is no `state`, no
 * `projects` and no `connections` among the dependencies: the project's
 * existence is a row this feature can read, and where a step of a run lands
 * is the runtime's question (AGX-146), decided per node when the run happens.
 *
 * ## What publish refuses
 *
 * Publishing is the moment a draft becomes something a run can name, so it is
 * where the rules a document cannot state about itself are applied:
 *
 *   - a graph starts at its one TRIGGER node, so a document with none or with
 *     two has nowhere definite to begin;
 *   - an ACTION node names an action the hub would perform, and this build
 *     performs none, so a graph with one would publish a step that can only
 *     fail -- refused now, in words, rather than at step six of a run;
 *   - a SUB-GRAPH node pins a published version of another graph, and a pin
 *     at a version nobody has published is a step that would read nothing.
 *
 * The draft is left exactly as it was on a refusal. The canvas can go on
 * editing it, and the sentence says what to change.
 *
 * `publishedVersion` is the seam the runtime resolves a pin through (AGX-265):
 * it answers a published document or `null`, never the draft, so nothing that
 * runs can ever be reading something the canvas is still editing.
 */

export interface GraphsDependencies {
  /** Where the rows live. This feature is the only writer of the tables it owns. */
  readonly database: Database;
  /** Where a graph node's primary key comes from. */
  readonly ids: IdGenerator;
  /** The hub's clock, which is the right one: the hub is the machine that holds a graph. */
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Told when a graph was made, because a graph is a node and the tree just
   * changed. The same callback a document create fires. A save and a publish
   * do not fire it: neither changes a row the tree carries.
   */
  readonly onTreeChanged: () => void;
}

/** Why the hub said no, in the terms a client is answered in. */
export interface GraphRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly problem: string;
}

export type GraphCreated = { readonly ok: true; readonly nodeId: NodeId } | GraphRefusal;
export type GraphSaved =
  { readonly ok: true; readonly version: number; readonly updatedAt: number } | GraphRefusal;
export type GraphPublished = { readonly ok: true; readonly version: number } | GraphRefusal;
export type GraphOpened =
  | {
      readonly ok: true;
      readonly nodeId: NodeId;
      readonly name: string;
      readonly draftVersion: number;
      readonly document: GraphDocument;
      readonly published: readonly GraphPublishedVersion[];
    }
  | GraphRefusal;

export interface Graphs {
  /** Makes a graph under a project: a node, and draft v1 holding nothing. */
  create(projectId: NodeId, name: string): Promise<GraphCreated>;
  /** The graph's name, its draft and number, and which versions are published. */
  open(nodeId: NodeId): Promise<GraphOpened>;
  /** Replaces the draft whole and says when. */
  save(nodeId: NodeId, document: GraphDocument): Promise<GraphSaved>;
  /** Stamps the draft as the next version and opens a new draft copying it, or refuses in words. */
  publish(nodeId: NodeId): Promise<GraphPublished>;
  /** A published version's document, or `null` for the draft, an unreached number or a node that is no graph. */
  publishedVersion(nodeId: NodeId, version: number): Promise<GraphDocument | null>;
}

const NO_SUCH_GRAPH: GraphRefusal = {
  ok: false,
  code: 'refused',
  problem: 'this hub has no graph by that id',
};

/** What a node is called in a refusal: its label, or its id when it has none. */
function nameOf(node: GraphNode): string {
  return node.label.trim().length > 0 ? node.label : node.id;
}

export function createGraphs(dependencies: GraphsDependencies): Graphs {
  const { database, ids, clock, onTreeChanged } = dependencies;
  const logger = dependencies.logger.child({ part: 'graphs' });

  async function publishedVersion(nodeId: NodeId, version: number): Promise<GraphDocument | null> {
    const row = await readVersion(database, nodeId, version);
    if (row === null || row.publishedAt === null) return null;
    return row.document;
  }

  /**
   * Why this document cannot be published, or `null` when it can.
   *
   * The checks run in the order a person would fix them: where the graph
   * starts, then each node that cannot run. The first problem is the answer,
   * because a sentence with three problems in it is one nobody acts on.
   */
  async function unpublishable(document: GraphDocument): Promise<string | null> {
    const triggers = document.nodes.filter((node) => node.kind === 'trigger');
    if (triggers.length === 0) return 'a graph needs a TRIGGER node to start from';
    if (triggers.length > 1) {
      return `a graph has one TRIGGER node, and this one has ${String(triggers.length)}`;
    }

    for (const node of document.nodes) {
      switch (node.kind) {
        case 'action':
          return (
            `the ACTION node ${nameOf(node)} names ${node.name}, and ` +
            'no action of that name exists on this build'
          );
        case 'subgraph': {
          const pinned = await publishedVersion(node.graph, node.version);
          if (pinned === null) {
            return (
              `the SUB-GRAPH node ${nameOf(node)} pins ${node.graph} at v${String(node.version)}, ` +
              'which is not a published version of any graph this hub has'
            );
          }
          break;
        }
        case 'trigger':
        case 'router':
        case 'agent':
        case 'human':
          break;
      }
    }
    return null;
  }

  return {
    async create(projectId: NodeId, name: string): Promise<GraphCreated> {
      const trimmed = name.trim();
      if (trimmed === '') return { ok: false, code: 'refused', problem: 'a graph needs a name' };

      const inserted = await insertGraph(database, ids, clock, {
        projectNodeId: projectId,
        name: trimmed,
      });
      if (!inserted.ok) {
        if ('noProject' in inserted) {
          return { ok: false, code: 'refused', problem: 'this hub has no project by that id' };
        }
        return {
          ok: false,
          code: 'refused',
          problem: `that project already has a graph called ${trimmed}: open it, or give this one another name`,
        };
      }

      logger.info('graph created', { nodeId: inserted.nodeId, projectId });
      onTreeChanged();
      return { ok: true, nodeId: inserted.nodeId };
    },

    async open(nodeId: NodeId): Promise<GraphOpened> {
      const graph = await readGraph(database, nodeId);
      if (graph === null) return NO_SUCH_GRAPH;
      const draft = await readDraft(database, nodeId);
      if (draft === null) {
        // The schema makes this unreachable: a graph is inserted with its
        // draft in one transaction and a publish opens the next in one. Said
        // in words rather than thrown, because a refusal is what a client can
        // read.
        logger.error('a graph has no draft', { nodeId });
        return { ok: false, code: 'internal', problem: 'this graph has no draft to open' };
      }
      return {
        ok: true,
        nodeId: graph.nodeId,
        name: graph.name,
        draftVersion: draft.version,
        document: draft.document,
        published: await listPublishedVersions(database, nodeId),
      };
    },

    async save(nodeId: NodeId, document: GraphDocument): Promise<GraphSaved> {
      const updatedAt = clock.now();
      const replaced = await replaceDraft(database, nodeId, document, updatedAt);
      if (replaced === null) return NO_SUCH_GRAPH;
      return { ok: true, version: replaced.version, updatedAt };
    },

    async publish(nodeId: NodeId): Promise<GraphPublished> {
      const draft = await readDraft(database, nodeId);
      if (draft === null) return NO_SUCH_GRAPH;

      const problem = await unpublishable(draft.document);
      if (problem !== null) {
        logger.info('graph publish refused', { nodeId, problem });
        return { ok: false, code: 'refused', problem };
      }

      const published = await publishDraft(database, nodeId, clock.now());
      if (published === null) return NO_SUCH_GRAPH;
      logger.info('graph published', { nodeId, version: published.version });
      return { ok: true, version: published.version };
    },

    publishedVersion,
  };
}
