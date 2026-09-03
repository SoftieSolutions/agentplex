import { z } from 'zod';
import { hubIdSchema, type HubId } from '@agentplex/protocol';
import type { Database } from './db/database.js';
import type { Clock } from '../shared/clock.js';
import type { IdGenerator } from '../shared/ids.js';

const identityRowSchema = z.object({ hub_id: hubIdSchema });

/**
 * Reads the hub's durable id, minting it on the first run.
 *
 * `ON CONFLICT DO NOTHING` against a single-row table makes the mint idempotent
 * without a read-then-write race: two hubs starting at once produce one id, and
 * the loser reads the winner's.
 *
 * `only_row` is left to the schema's default and `created_at` is not, because
 * one of the two is a constant and the other is a reading of the clock. The
 * clock is injected for the same reason it is everywhere else above the
 * database: minting an identity is a thing that happened at a time a test gets
 * to decide.
 */
export async function ensureHubIdentity(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
): Promise<HubId> {
  await database.query(
    'INSERT INTO hub_identity (hub_id, created_at) VALUES (?, ?) ON CONFLICT (only_row) DO NOTHING',
    [ids.newId(), clock.now()],
  );

  const result = await database.query('SELECT hub_id FROM hub_identity');
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('hub_identity is empty immediately after an insert; the database is not ours');
  }
  return identityRowSchema.parse(row).hub_id;
}
