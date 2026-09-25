import { z } from 'zod';
import {
  docNameSchema,
  nodeIdSchema,
  nodeKindSchema,
  serverRegistrationIdSchema,
  type DocName,
  type NodeId,
  type NodeKind,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database, Queryable } from '../db/database.js';

/**
 * A document, as rows: the two inserts that make one and the reads that answer
 * for it.
 *
 * ## Why this folder writes `nodes`
 *
 * The same argument `project-rows.ts` makes, and it is the same shape. A
 * document is one `nodes` row and one `docs` row that only mean anything
 * together: a node of kind `doc` with no side row is something a client would
 * try to open and get nothing back for, and a side row with no node is a file
 * on a machine that nothing can put on a screen. Splitting the two inserts
 * across a feature boundary would mean a transaction neither feature owns, and
 * the states in between are exactly the pair the schema was arranged to make
 * unrepresentable. So the feature that owns what a document *is* writes both,
 * in one transaction, and the catalogue goes on reading every node including
 * these.
 *
 * The edge runs one way, which is what keeps that honest: this feature reads
 * projects (for the directory a frame is addressed to) and the catalogue reads
 * neither.
 *
 * ## Why the index is written after the server answered, never before
 *
 * Every write here happens on the far side of a reply. The hub does not hold a
 * document, so a row it wrote before asking would be a claim about a file that
 * may not exist -- and the failure is not hypothetical: a machine that refuses
 * a write because its disk is full would leave a node in the tree that opens
 * as a refusal forever. Writing after the reply costs the opposite case, a
 * file on disk that no row names, and that is the direction that does not
 * over-claim: the file is inert, a later create with the same name replaces
 * it, and `doc-list` on the server leg can find it. The feature file carries
 * the rest of this argument.
 */

/** The kind a document node gets. Seeded by migration 0006, not by this. */
export const DOC_KIND: NodeKind = nodeKindSchema.parse('doc');

const docRowSchema = z
  .object({
    node_id: nodeIdSchema,
    project_node_id: nodeIdSchema,
    server_registration_id: serverRegistrationIdSchema,
    name: docNameSchema,
    updated_at: z.number().int(),
  })
  .transform((row) => ({
    nodeId: row.node_id,
    projectNodeId: row.project_node_id,
    server: row.server_registration_id,
    name: row.name,
    updatedAt: row.updated_at,
  }));

/** One document, parsed: where it lives, which machine has it, and when. */
export type DocRow = z.infer<typeof docRowSchema>;

const COLUMNS = 'node_id, project_node_id, server_registration_id, name, updated_at';

export interface NewDoc {
  readonly projectNodeId: NodeId;
  readonly server: ServerRegistrationId;
  readonly name: DocName;
  /** The write time the machine reported. Never the hub's own clock. */
  readonly updatedAt: number;
}

export type DocInsert =
  | { readonly ok: true; readonly nodeId: NodeId }
  /** That project already has a document of that name on that machine. */
  | { readonly ok: false; readonly duplicate: true };

/**
 * Makes a document: a node under its project, and the row that says what it is.
 *
 * The node's name is the file's name, because that is what the user typed and
 * what they will look for. It is `nodes.name` they may later rename, and
 * `docs.name` that a read is addressed by -- two columns holding the same
 * string today and meaning two different things, which is why a rename can
 * never change which file opens.
 *
 * The duplicate check is inside the transaction rather than left to the unique
 * index, for the reason `insertProject` gives: SQLite reports a constraint
 * failure as text, and matching on that text is the cast this repository does
 * not do. The caller checks once more before it asks the server, which is the
 * check that saves a file from being overwritten; this one is what makes the
 * rows correct when two clients race.
 */
export async function insertDoc(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  doc: NewDoc,
): Promise<DocInsert> {
  return database.transaction(async (tx) => {
    if ((await findDoc(tx, doc.projectNodeId, doc.server, doc.name)) !== null) {
      return { ok: false, duplicate: true };
    }

    const nodeId = nodeIdSchema.parse(ids.newId());
    // The hub's clock for the node, the server's for the document. A node was
    // created here and now; the file was written over there and then.
    await tx.query(
      `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
       SELECT ?, ?, ?, coalesce(max(position), -1) + 1, ?, 'user', ?
         FROM nodes WHERE parent_id IS ?`,
      [nodeId, doc.projectNodeId, DOC_KIND, doc.name, clock.now(), doc.projectNodeId],
    );
    await tx.query(`INSERT INTO docs (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
      nodeId,
      doc.projectNodeId,
      doc.server,
      doc.name,
      doc.updatedAt,
    ]);
    return { ok: true, nodeId };
  });
}

/** One document by node, or `null` when that node is not one. */
export async function readDoc(database: Queryable, nodeId: NodeId): Promise<DocRow | null> {
  const result = await database.query(`SELECT ${COLUMNS} FROM docs WHERE node_id = ?`, [nodeId]);
  const row = result.rows[0];
  return row === undefined ? null : docRowSchema.parse(row);
}

/** The document of that name in that project on that machine, or `null`. */
export async function findDoc(
  database: Queryable,
  projectNodeId: NodeId,
  server: ServerRegistrationId,
  name: DocName,
): Promise<DocRow | null> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM docs
      WHERE project_node_id = ? AND server_registration_id = ? AND name = ?`,
    [projectNodeId, server, name],
  );
  const row = result.rows[0];
  return row === undefined ? null : docRowSchema.parse(row);
}

/**
 * Every document in one project, across every machine that has one.
 *
 * Ordered by name and then by machine, so that two documents called the same
 * thing on two machines sit together rather than wherever the planner put
 * them. The ordering is the query's rather than the caller's because the hub
 * already reads the rows sorted, and two clients sorting one set by their own
 * rules is how two screens come to disagree.
 */
export async function listDocs(
  database: Queryable,
  projectNodeId: NodeId,
): Promise<readonly DocRow[]> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM docs
      WHERE project_node_id = ?
      ORDER BY name, server_registration_id`,
    [projectNodeId],
  );
  return result.rows.map((row) => docRowSchema.parse(row));
}

/**
 * Records what a machine just said about when a document was written.
 *
 * Called after a write and after a read, and the second is not redundant: the
 * file is editable on the machine that holds it -- by a person, or by the
 * agent the document was written for -- so a read is the hub finding out that
 * its index was behind. Answers whether there was a row to record it on.
 */
export async function touchDoc(
  database: Queryable,
  nodeId: NodeId,
  updatedAt: number,
): Promise<boolean> {
  const result = await database.query('UPDATE docs SET updated_at = ? WHERE node_id = ?', [
    updatedAt,
    nodeId,
  ]);
  return result.rowCount > 0;
}
