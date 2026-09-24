import { z } from 'zod';
import {
  graphRunIdSchema,
  graphRunStepSchema,
  nodeIdSchema,
  routeInputSchema,
  runStatusSchema,
  type GraphRunId,
  type GraphRunStep,
  type NodeId,
  type RouteInput,
  type RunStatus,
} from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';

/**
 * A run, as rows.
 *
 * The one table the runtime owns, and the only durable thing it produces.
 * Everything here is a read or a write of `graph_runs`; the rules about what
 * a run does live in `walker.ts` and `graph-runs.ts`, and this file knows
 * only what a row is and how a number is allocated.
 *
 * ## The number is allocated in the transaction
 *
 * `insertRun` reads the graph's highest number and writes the next inside one
 * transaction, which the database serialises with `BEGIN IMMEDIATE`. Two runs
 * started in the same tick therefore see each other's row or wait; the UNIQUE
 * on `(graph_node_id, number)` is the schema saying the same thing, so that a
 * write from outside this file cannot produce two run 38s either.
 *
 * ## JSON in, schema out
 *
 * `input` and `steps` are text in the table and parsed values here, through
 * the protocol's own schemas and never a cast, for the reason `graph-rows.ts`
 * gives: the hub wrote them out of parsed values, so a row that fails to
 * read back is a bug or a damaged database, and either is something to stop
 * on rather than a run to draw.
 */

/** JSON text to a value, refused in words rather than thrown as a syntax error. */
function storedJson<T>(schema: z.ZodType<T>, what: string): z.ZodType<T> {
  return z
    .string()
    .transform((text, context): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        context.addIssue({ code: 'custom', message: `a stored ${what} is not JSON` });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

const runRowSchema = z
  .object({
    id: graphRunIdSchema,
    graph_node_id: nodeIdSchema,
    version: z.int().positive(),
    number: z.int().positive(),
    input: storedJson(routeInputSchema, 'run input'),
    steps: storedJson(z.array(graphRunStepSchema), 'step list'),
    status: runStatusSchema,
    reason: z.string().nullable(),
    started_at: z.int(),
    ended_at: z.int().nullable(),
  })
  .transform((row) => ({
    runId: row.id,
    graphNodeId: row.graph_node_id,
    version: row.version,
    number: row.number,
    input: row.input,
    steps: row.steps,
    status: row.status,
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));

/** One run, whole, as the table holds it. */
export type RunRow = z.infer<typeof runRowSchema>;

export interface NewRun {
  readonly graphNodeId: NodeId;
  /** The published version being run. A version the graph never had is refused by the schema. */
  readonly version: number;
  readonly input: RouteInput;
}

/** What a run ends with: its final status, the sentence if any, and the steps as they stand. */
export interface RunEnd {
  readonly status: Exclude<RunStatus, 'running'>;
  readonly reason: string | null;
  readonly steps: readonly GraphRunStep[];
  readonly endedAt: number;
}

const COLUMNS =
  'id, graph_node_id, version, number, input, steps, status, reason, started_at, ended_at';

/**
 * Makes a run row, numbered next for its graph, in one transaction.
 *
 * Throws on a version the graph never had -- the foreign key's word -- which
 * is a caller that did not read the graph first rather than something to
 * answer in a sentence here.
 */
export async function insertRun(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  run: NewRun,
): Promise<{ readonly runId: GraphRunId; readonly number: number }> {
  return database.transaction(async (tx) => {
    const highest = await tx.query(
      'SELECT coalesce(max(number), 0) AS highest FROM graph_runs WHERE graph_node_id = ?',
      [run.graphNodeId],
    );
    const number = z.int().nonnegative().parse(highest.rows[0]?.['highest']) + 1;
    const runId = graphRunIdSchema.parse(ids.newId());
    await tx.query(
      `INSERT INTO graph_runs (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, '[]', 'running', NULL, ?, NULL)`,
      [runId, run.graphNodeId, run.version, number, JSON.stringify(run.input), clock.now()],
    );
    return { runId, number };
  });
}

/** Writes the steps as they stand, for a run still going. */
export async function replaceSteps(
  database: Queryable,
  runId: GraphRunId,
  steps: readonly GraphRunStep[],
): Promise<void> {
  await database.query('UPDATE graph_runs SET steps = ? WHERE id = ?', [
    JSON.stringify(steps),
    runId,
  ]);
}

/** Ends a run: its status, its sentence, its final steps and when. */
export async function endRun(database: Queryable, runId: GraphRunId, end: RunEnd): Promise<void> {
  await database.query(
    'UPDATE graph_runs SET status = ?, reason = ?, steps = ?, ended_at = ? WHERE id = ?',
    [end.status, end.reason, JSON.stringify(end.steps), end.endedAt, runId],
  );
}

/** One run by id, or `null` when there is none. */
export async function readRun(database: Queryable, runId: GraphRunId): Promise<RunRow | null> {
  const result = await database.query(`SELECT ${COLUMNS} FROM graph_runs WHERE id = ?`, [runId]);
  const row = result.rows[0];
  return row === undefined ? null : runRowSchema.parse(row);
}

/** One graph's newest run, or `null` when it has never run. */
export async function latestRun(database: Queryable, graphNodeId: NodeId): Promise<RunRow | null> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM graph_runs WHERE graph_node_id = ? ORDER BY number DESC LIMIT 1`,
    [graphNodeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : runRowSchema.parse(row);
}

/** Every run of one graph, newest first. */
export async function listRuns(
  database: Queryable,
  graphNodeId: NodeId,
): Promise<readonly RunRow[]> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM graph_runs WHERE graph_node_id = ? ORDER BY number DESC`,
    [graphNodeId],
  );
  return result.rows.map((row) => runRowSchema.parse(row));
}

/**
 * Ends every run still marked running, with one reason, and says how many.
 *
 * The boot sweep: a row left running belongs to a process that is gone, and
 * nothing resumes it. The reason names the restart so a person reading the
 * history sees why run 38 stopped at step 3 with no node blamed.
 */
export async function failRunningRuns(
  database: Queryable,
  endedAt: number,
  reason: string,
): Promise<number> {
  const result = await database.query(
    `UPDATE graph_runs SET status = 'failed', reason = ?, ended_at = ? WHERE status = 'running'`,
    [reason, endedAt],
  );
  return result.rowCount;
}
