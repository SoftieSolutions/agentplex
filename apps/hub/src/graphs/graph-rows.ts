import { z } from 'zod';
import {
  emptyGraphDocument,
  graphDocumentSchema,
  nodeIdSchema,
  nodeKindSchema,
  type GraphDocument,
  type GraphPublishedVersion,
  type NodeId,
  type NodeKind,
} from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database, Queryable } from '../db/database.js';

/**
 * A graph, as rows: the node, the side row, and the versions.
 *
 * ## Why this folder writes `nodes`
 *
 * The argument `doc-rows.ts` makes, and it is the same shape: a graph is one
 * `nodes` row, one `graphs` row and one draft in `graph_versions`, and they
 * only mean anything together. A node of kind `graph` with no draft is a card
 * the canvas cannot open; a draft with no node is a document nothing can put
 * on a screen. So the feature that owns what a graph *is* writes all three, in
 * one transaction, and the catalogue goes on reading every node including
 * these.
 *
 * ## The document is parsed on the way out
 *
 * `document` is text in the table and a `GraphDocument` here, and the only
 * way from one to the other is `graphDocumentSchema`. A row that does not
 * parse throws rather than being handed on as whatever it is: the hub wrote
 * that text out of a parsed document, so a row that fails to read back is a
 * bug or a corrupted database, and either is a thing to stop on rather than
 * a run to start.
 */

/** The kind a graph node gets. Seeded by migration 0017, not by this. */
export const GRAPH_KIND: NodeKind = nodeKindSchema.parse('graph');

/** JSON text to a document, through the one schema, and never a cast. */
const storedDocumentSchema = z
  .string()
  .transform((text, context): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'a stored graph document is not JSON' });
      return z.NEVER;
    }
  })
  .pipe(graphDocumentSchema);

const graphRowSchema = z
  .object({
    node_id: nodeIdSchema,
    project_node_id: nodeIdSchema,
    name: z.string(),
  })
  .transform((row) => ({
    nodeId: row.node_id,
    projectNodeId: row.project_node_id,
    name: row.name,
  }));

/** One graph: the node it is, the project it belongs to, and what the tree calls it. */
export type GraphRow = z.infer<typeof graphRowSchema>;

const draftRowSchema = z
  .object({
    version: z.int().positive(),
    document: storedDocumentSchema,
    updated_at: z.int(),
  })
  .transform((row) => ({
    version: row.version,
    document: row.document,
    updatedAt: row.updated_at,
  }));

/** The draft: the one version of a graph that changes. */
export type DraftRow = z.infer<typeof draftRowSchema>;

const versionRowSchema = z
  .object({
    version: z.int().positive(),
    document: storedDocumentSchema,
    updated_at: z.int(),
    published_at: z.int().nullable(),
  })
  .transform((row) => ({
    version: row.version,
    document: row.document,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }));

/** Any one version, published or the draft. */
export type VersionRow = z.infer<typeof versionRowSchema>;

const publishedRowSchema = z
  .object({ version: z.int().positive(), published_at: z.int() })
  .transform((row): GraphPublishedVersion => ({
    version: row.version,
    publishedAt: row.published_at,
  }));

export interface NewGraph {
  readonly projectNodeId: NodeId;
  readonly name: string;
}

export type GraphInsert =
  | { readonly ok: true; readonly nodeId: NodeId }
  /** That project already has a graph called that. */
  | { readonly ok: false; readonly duplicate: true }
  /** The node named is not a project. */
  | { readonly ok: false; readonly noProject: true };

/**
 * Makes a graph: a node under its project, the row that says what it is, and
 * draft version 1 holding the empty document.
 *
 * The duplicate check is a query inside the transaction rather than a unique
 * index, because the name lives on `nodes` and is the user's to change: an
 * index over `(parent_id, name)` would refuse a rename that collided with a
 * graph in the same folder as if the folder were the project. What the check
 * refuses is the common mistake -- making the same graph twice -- and it is
 * made in the same transaction as the insert so two racing creates come out
 * as one graph and one refusal.
 */
export async function insertGraph(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  graph: NewGraph,
): Promise<GraphInsert> {
  return database.transaction(async (tx) => {
    const project = await tx.query('SELECT node_id FROM projects WHERE node_id = ?', [
      graph.projectNodeId,
    ]);
    if (project.rows.length === 0) return { ok: false, noProject: true };

    const taken = await tx.query(
      `SELECT g.node_id FROM graphs g JOIN nodes n ON n.id = g.node_id
        WHERE g.project_node_id = ? AND n.name = ?`,
      [graph.projectNodeId, graph.name],
    );
    if (taken.rows.length > 0) return { ok: false, duplicate: true };

    const nodeId = nodeIdSchema.parse(ids.newId());
    const now = clock.now();
    await tx.query(
      `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
       SELECT ?, ?, ?, coalesce(max(position), -1) + 1, ?, 'user', ?
         FROM nodes WHERE parent_id IS ?`,
      [nodeId, graph.projectNodeId, GRAPH_KIND, graph.name, now, graph.projectNodeId],
    );
    await tx.query('INSERT INTO graphs (node_id, project_node_id, created_at) VALUES (?, ?, ?)', [
      nodeId,
      graph.projectNodeId,
      now,
    ]);
    await tx.query(
      `INSERT INTO graph_versions (graph_node_id, version, document, updated_at, published_at)
       VALUES (?, 1, ?, ?, NULL)`,
      [nodeId, JSON.stringify(emptyGraphDocument()), now],
    );
    return { ok: true, nodeId };
  });
}

/** One graph by node, or `null` when that node is not one. */
export async function readGraph(database: Queryable, nodeId: NodeId): Promise<GraphRow | null> {
  const result = await database.query(
    `SELECT g.node_id, g.project_node_id, n.name FROM graphs g JOIN nodes n ON n.id = g.node_id
      WHERE g.node_id = ?`,
    [nodeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : graphRowSchema.parse(row);
}

/** The draft of that graph, or `null` when that node is not a graph. */
export async function readDraft(database: Queryable, nodeId: NodeId): Promise<DraftRow | null> {
  const result = await database.query(
    `SELECT version, document, updated_at FROM graph_versions
      WHERE graph_node_id = ? AND published_at IS NULL`,
    [nodeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : draftRowSchema.parse(row);
}

/** One version by number, published or the draft, or `null` when there is none. */
export async function readVersion(
  database: Queryable,
  nodeId: NodeId,
  version: number,
): Promise<VersionRow | null> {
  const result = await database.query(
    `SELECT version, document, updated_at, published_at FROM graph_versions
      WHERE graph_node_id = ? AND version = ?`,
    [nodeId, version],
  );
  const row = result.rows[0];
  return row === undefined ? null : versionRowSchema.parse(row);
}

/** The newest published version of that graph, or `null` when nothing is published or that node is no graph. */
export async function readLatestPublished(
  database: Queryable,
  nodeId: NodeId,
): Promise<VersionRow | null> {
  const result = await database.query(
    `SELECT version, document, updated_at, published_at FROM graph_versions
      WHERE graph_node_id = ? AND published_at IS NOT NULL
      ORDER BY version DESC LIMIT 1`,
    [nodeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : versionRowSchema.parse(row);
}

/** Every published version of that graph, oldest first. */
export async function listPublishedVersions(
  database: Queryable,
  nodeId: NodeId,
): Promise<readonly GraphPublishedVersion[]> {
  const result = await database.query(
    `SELECT version, published_at FROM graph_versions
      WHERE graph_node_id = ? AND published_at IS NOT NULL
      ORDER BY version`,
    [nodeId],
  );
  return result.rows.map((row) => publishedRowSchema.parse(row));
}

/**
 * Replaces the draft document whole. Answers the draft's number, or `null`
 * when that node has no draft, which is to say is not a graph.
 */
export async function replaceDraft(
  database: Queryable,
  nodeId: NodeId,
  document: GraphDocument,
  updatedAt: number,
): Promise<{ readonly version: number } | null> {
  const result = await database.query(
    `UPDATE graph_versions SET document = ?, updated_at = ?
      WHERE graph_node_id = ? AND published_at IS NULL
      RETURNING version`,
    [JSON.stringify(document), updatedAt, nodeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { version: z.int().positive().parse(row['version']) };
}

/**
 * What a publish came to: the number the draft was frozen as, why the check
 * refused it, or `null` when that node is not a graph.
 */
export type PublishOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly problem: string };

/**
 * Stamps the draft as published and opens the next draft as a copy of it,
 * once `unpublishable` has found nothing against it.
 *
 * One transaction, because the state between the two statements -- a graph
 * with no draft -- is exactly what the partial unique index exists to make
 * impossible from outside, and it should be impossible from inside too.
 *
 * The check runs inside it, on the draft this transaction read, and is handed
 * the transaction to read anything else through. A check run before the
 * transaction judges a document that another client's save may have replaced
 * by the time the freeze happens, and the row that was frozen is then one
 * nothing checked. The rows module does not know the rules -- the feature
 * does -- so the rules arrive as a function and the one thing promised here
 * is that they are asked about the document that gets published.
 *
 * The new draft's `updated_at` is the publish moment: it was last written
 * then, by the publish that made it. Its document is copied in SQL from the
 * row just frozen, so what the draft holds is what was published, byte for
 * byte, and never a second serialisation of it.
 */
export async function publishDraft(
  database: Database,
  nodeId: NodeId,
  publishedAt: number,
  unpublishable: (tx: Queryable, document: GraphDocument) => Promise<string | null>,
): Promise<PublishOutcome | null> {
  return database.transaction(async (tx) => {
    const draft = await readDraft(tx, nodeId);
    if (draft === null) return null;
    const problem = await unpublishable(tx, draft.document);
    if (problem !== null) return { ok: false, problem };

    await tx.query(
      'UPDATE graph_versions SET published_at = ? WHERE graph_node_id = ? AND version = ?',
      [publishedAt, nodeId, draft.version],
    );
    await tx.query(
      `INSERT INTO graph_versions (graph_node_id, version, document, updated_at, published_at)
       SELECT graph_node_id, version + 1, document, ?, NULL FROM graph_versions
        WHERE graph_node_id = ? AND version = ?`,
      [publishedAt, nodeId, draft.version],
    );
    return { ok: true, version: draft.version };
  });
}
