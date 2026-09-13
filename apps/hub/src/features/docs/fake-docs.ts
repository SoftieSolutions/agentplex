import {
  nodeIdSchema,
  type DocName,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type { DocCreated, DocListed, DocOpened, Docs, DocSaved, DocSummary } from './docs.js';

/**
 * The hub's documents, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-projects.ts` is one: what a client connection has to get right is what
 * it does with an outcome -- a node id, a refusal naming the machine that is
 * away, a content reply with the write time on it -- and each of those is a
 * value this hands back. The index and the relay are tested where they live,
 * and end to end against a real server over a real handshake. This is for the
 * tests whose subject is the socket.
 *
 * It holds content, which the real feature never does, and that is the point
 * of a fake rather than a lapse: the machine at the far end is exactly what a
 * suite about a socket does not have, so the fake stands in for the file as
 * well as for the index.
 */
export interface FakeDocs extends Docs {
  /** Every create asked for, in order. */
  readonly created: readonly {
    nodeId: NodeId;
    projectId: NodeId;
    server: ServerRegistrationId;
    name: DocName;
    content: string;
  }[];
  /** Every save asked for, in order. */
  readonly saved: readonly { nodeId: NodeId; content: string }[];
  /** Every open asked for, in order. */
  readonly opened: readonly NodeId[];
  /** Every listing asked for, in order. */
  readonly listed: readonly NodeId[];
  /** What every later call answers with, in place of the held documents. */
  refuseWith(refusal: { code: 'refused' | 'internal'; problem: string } | null): void;
  /** Puts a document in this fake without going through `create`. */
  hold(doc: {
    nodeId: NodeId;
    projectId: NodeId;
    server: ServerRegistrationId;
    name: DocName;
    content: string;
    updatedAt: number;
  }): void;
}

export interface FakeDocsOptions {
  /** What a write reports back as the moment it landed. */
  readonly updatedAt?: number;
  /** What every machine in this fake is called, for a listing's label. */
  readonly label?: string;
}

interface Held {
  readonly nodeId: NodeId;
  readonly projectId: NodeId;
  readonly server: ServerRegistrationId;
  readonly name: DocName;
  content: string;
  updatedAt: number;
}

export function createFakeDocs(options: FakeDocsOptions = {}): FakeDocs {
  const created: {
    nodeId: NodeId;
    projectId: NodeId;
    server: ServerRegistrationId;
    name: DocName;
    content: string;
  }[] = [];
  const saved: { nodeId: NodeId; content: string }[] = [];
  const opened: NodeId[] = [];
  const listed: NodeId[] = [];
  const held = new Map<NodeId, Held>();
  const label = options.label ?? 'the-machine';
  let updatedAt = options.updatedAt ?? 1_756_000_000_000;
  let refusal: { code: 'refused' | 'internal'; problem: string } | null = null;
  let minted = 0;

  const missing = (nodeId: NodeId): DocOpened => ({
    ok: false,
    code: 'refused',
    problem: `this fake holds no document ${nodeId}`,
  });

  return {
    async create(
      projectId: NodeId,
      server: ServerRegistrationId,
      name: DocName,
      content: string,
    ): Promise<DocCreated> {
      if (refusal !== null) return { ok: false, ...refusal };
      for (const doc of held.values()) {
        if (doc.projectId !== projectId || doc.server !== server || doc.name !== name) continue;
        return {
          ok: false,
          code: 'refused',
          problem: `that project already has a document called ${name} on ${label}`,
        };
      }
      const nodeId = nodeIdSchema.parse(`doc-${String((minted += 1))}`);
      held.set(nodeId, { nodeId, projectId, server, name, content, updatedAt });
      created.push({ nodeId, projectId, server, name, content });
      return { ok: true, nodeId };
    },

    async save(nodeId: NodeId, content: string): Promise<DocSaved> {
      saved.push({ nodeId, content });
      if (refusal !== null) return { ok: false, ...refusal };
      const doc = held.get(nodeId);
      if (doc === undefined) {
        return { ok: false, code: 'refused', problem: `this fake holds no document ${nodeId}` };
      }
      doc.content = content;
      doc.updatedAt = updatedAt += 1;
      return { ok: true, updatedAt: doc.updatedAt };
    },

    async open(nodeId: NodeId): Promise<DocOpened> {
      opened.push(nodeId);
      if (refusal !== null) return { ok: false, ...refusal };
      const doc = held.get(nodeId);
      if (doc === undefined) return missing(nodeId);
      return { ok: true, content: doc.content, updatedAt: doc.updatedAt };
    },

    async list(projectId: NodeId): Promise<DocListed> {
      listed.push(projectId);
      if (refusal !== null) return { ok: false, ...refusal };
      const docs: DocSummary[] = [];
      for (const doc of held.values()) {
        if (doc.projectId !== projectId) continue;
        docs.push({
          nodeId: doc.nodeId,
          name: doc.name,
          server: doc.server,
          label,
          reachable: true,
          updatedAt: doc.updatedAt,
        });
      }
      return { ok: true, docs };
    },

    refuseWith(next: { code: 'refused' | 'internal'; problem: string } | null): void {
      refusal = next;
    },

    hold(doc: {
      nodeId: NodeId;
      projectId: NodeId;
      server: ServerRegistrationId;
      name: DocName;
      content: string;
      updatedAt: number;
    }): void {
      held.set(doc.nodeId, { ...doc });
    },

    get created() {
      return created;
    },

    get saved() {
      return saved;
    },

    get opened() {
      return opened;
    },

    get listed() {
      return listed;
    },
  };
}
