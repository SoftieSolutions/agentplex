import { z } from 'zod';
import {
  NODE_NAME_MAX_CHARS,
  nodeIdSchema,
  nodeKindSchema,
  normaliseDirectory,
  type NodeId,
  type NodeKind,
} from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';

/**
 * A project, as rows: the two inserts that make one and the two reads that
 * answer for it.
 *
 * ## Why this folder writes `nodes` at all
 *
 * The catalogue owns the tree -- who may place a node, who may rename one, what
 * a removal remembers -- and everything here is subject to those rules rather
 * than an exception to them. What it does not own is *a project*, which is one
 * `nodes` row and one `projects` row that only mean anything together: a node
 * of kind `project` with no side row is a container claiming to be a project it
 * cannot produce a directory for, and a side row with no node is a directory
 * nothing can put on a screen.
 *
 * Splitting those two inserts across a feature boundary would mean a
 * transaction that neither feature owns, and the state in between -- committed
 * separately, or committed by whichever half went first -- is exactly the pair
 * of states the schema was arranged to make unrepresentable. So the feature
 * that owns what a project *is* writes both, in one transaction, and the
 * catalogue goes on reading every node including these.
 *
 * The edge between the two features runs one way only, which is what keeps
 * this honest: the catalogue reads this feature (to file a session under the
 * project whose directory it ran in) and this feature reads nothing of the
 * catalogue's.
 *
 * ## Why there is no rename here
 *
 * There was one, scoped to project nodes by its WHERE clause, so that a node
 * id that was not a project's was refused rather than silently renaming a
 * folder. It is gone, along with the `project-rename` frame it served, because
 * the refusal it bought protects nobody: a client sending an id meant to
 * rename *that node*, and the catalogue's `node-rename` renames it. Keeping
 * both would have left two statements writing one column, answered by one
 * frame, with the tree's own context menu sending only the generic one -- a
 * second way to say one thing, and then a statement with no caller.
 */

/** The kind a project node gets. Seeded by migration 0006, not by this. */
export const PROJECT_KIND: NodeKind = nodeKindSchema.parse('project');

/**
 * What a project may be called, at the point it reaches a row.
 *
 * Trimmed, because a name of spaces is not a name, and the trim happens here
 * rather than in the client so that two clients cannot store two spellings of
 * one intent. The wire's `nodeNameTextSchema` only bounds the length -- see
 * `layout.ts` for why a blank name is a refusal in words and not a closed
 * socket -- so this is where the judgement is made.
 */
export const projectNameSchema = z.string().trim().min(1).max(NODE_NAME_MAX_CHARS);

const projectRowSchema = z
  .object({ node_id: nodeIdSchema, directory: z.string().min(1) })
  .transform((row) => ({ nodeId: row.node_id, directory: row.directory }));

/** One project, parsed. */
export type ProjectRow = z.infer<typeof projectRowSchema>;

export type ProjectInsert =
  | { readonly ok: true; readonly nodeId: NodeId }
  /** A project already holds this directory, and one directory is one project. */
  | { readonly ok: false; readonly duplicate: true };

/**
 * Makes a project: a node at the root, and the row that says what it is.
 *
 * At the root and not under a parent, because `project-create` names none. The
 * schema allows a project under a folder -- that is what a move is for -- and
 * creating one is not where that choice is made.
 *
 * The duplicate check is inside the transaction rather than left to the unique
 * index, and the difference is what the caller gets to say. SQLite raises a
 * constraint failure whose text is the only evidence of which constraint it
 * was, and matching on that text is the cast this repository does not do. One
 * connection under `BEGIN IMMEDIATE` makes the read and the insert atomic, so
 * the check is not a race it would be if two writers could interleave; the
 * index stays as the schema's own statement of the rule, which is what catches
 * anything that ever writes this table without coming through here.
 */
export async function insertProject(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  project: { readonly name: string; readonly directory: string },
): Promise<ProjectInsert> {
  const name = projectNameSchema.parse(project.name);
  const directory = normaliseDirectory(project.directory);

  return database.transaction(async (tx) => {
    if ((await findProjectByDirectory(tx, directory)) !== null) {
      return { ok: false, duplicate: true };
    }

    const nodeId = nodeIdSchema.parse(ids.newId());
    const now = clock.now();
    // `name_source` is `user` from the first millisecond: nobody discovered
    // this, and nothing may rename it but the person who made it.
    await tx.query(
      `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
       SELECT ?, NULL, ?, coalesce(max(position), -1) + 1, ?, 'user', ?
         FROM nodes WHERE parent_id IS NULL`,
      [nodeId, PROJECT_KIND, name, now],
    );
    await tx.query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
      nodeId,
      directory,
      now,
    ]);
    return { ok: true, nodeId };
  });
}

/** One project's directory, or `null` when that node is not a project. */
export async function readProjectDirectory(
  database: Queryable,
  nodeId: NodeId,
): Promise<string | null> {
  const result = await database.query('SELECT node_id, directory FROM projects WHERE node_id = ?', [
    nodeId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : projectRowSchema.parse(row).directory;
}

/**
 * The project holding this directory, or `null` when none does.
 *
 * The argument is normalised here rather than by the caller, so that every
 * question asked of this table is asked in the one spelling the table is keyed
 * by -- a `cwd` off a server's report and a directory off a client's frame are
 * both claims, and neither arrives normalised.
 */
export async function findProjectByDirectory(
  database: Queryable,
  directory: string,
): Promise<NodeId | null> {
  const result = await database.query(
    'SELECT node_id, directory FROM projects WHERE directory = ?',
    [normaliseDirectory(directory)],
  );
  const row = result.rows[0];
  return row === undefined ? null : projectRowSchema.parse(row).nodeId;
}

/**
 * Every project's directory, by node.
 *
 * One statement for the whole table rather than `readProjectDirectory` per
 * node, because its caller is the catalogue query, which resolves a whole
 * catalogue at once: a lookup per project node would be one round trip per
 * project to answer one page. The table is one row per project a person made,
 * so reading it whole is reading a few rows.
 */
export async function readProjectDirectories(
  database: Queryable,
): Promise<ReadonlyMap<NodeId, string>> {
  const result = await database.query('SELECT node_id, directory FROM projects');
  const directories = new Map<NodeId, string>();
  for (const row of result.rows) {
    const project = projectRowSchema.parse(row);
    directories.set(project.nodeId, project.directory);
  }
  return directories;
}
