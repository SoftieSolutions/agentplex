import { z } from 'zod';
import { paneLayoutTextSchema } from '@agentplex/protocol';
import type { Clock } from '../../shared/clock.js';
import type { Queryable } from '../db/database.js';

/**
 * The pane layout, as one opaque row.
 *
 * The node tree (`node-tree.ts`) is the hub's to read: discovery inserts into
 * it and the prune sweeps it. The pane layout is not — what a split is, what a
 * ratio means, and which kinds of pane exist are rules the web client owns —
 * so the hub's whole job here is to keep the characters the last save carried
 * and answer them back verbatim. That is a decision, not an omission: a hub
 * that parsed the layout would put a service release in front of every new
 * pane type, and the client already has to survive a blob it cannot read (an
 * older client meeting a newer one's save), so a second reader would add a
 * second opinion and no safety.
 *
 * "Never parses" means the arrangement. What comes back off disk is still a
 * claim and still goes through a parser — one that checks it is characters
 * within the protocol's bound, nothing more.
 */

const storedLayoutRowSchema = z.object({ layout: paneLayoutTextSchema });

/** The stored layout, verbatim, or `null` when nothing has ever been saved. */
export async function readPaneLayout(db: Queryable): Promise<string | null> {
  const result = await db.query('SELECT layout FROM pane_layout WHERE only = 1');
  const row = result.rows[0];
  if (row === undefined) return null;
  return storedLayoutRowSchema.parse(row).layout;
}

/**
 * Replaces the stored layout, whole.
 *
 * An upsert on the single permitted row rather than a delete-and-insert: one
 * statement means no moment in which the hub has no layout, and the CHECK on
 * `only` keeps a second arrangement unrepresentable rather than merely absent.
 */
export async function writePaneLayout(db: Queryable, layout: string, clock: Clock): Promise<void> {
  await db.query(
    `INSERT INTO pane_layout (only, layout, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (only) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
    [layout, clock.now()],
  );
}
