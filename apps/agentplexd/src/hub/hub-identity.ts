import { z } from 'zod';
import { hubIdSchema, type HubId } from '@agentplex/protocol';
import type { Database } from './db/database.js';
import type { IdGenerator } from '../shared/ids.js';

const identityRowSchema = z.object({ hub_id: hubIdSchema });

/**
 * Reads the hub's durable id, minting it on the first run.
 *
 * `ON CONFLICT DO NOTHING` against a single-row table makes the mint idempotent
 * without a read-then-write race: two hubs starting at once produce one id, and
 * the loser reads the winner's.
 */
export async function ensureHubIdentity(database: Database, ids: IdGenerator): Promise<HubId> {
  await database.query(
    'INSERT INTO hub_identity (hub_id) VALUES ($1) ON CONFLICT (only_row) DO NOTHING',
    [ids.newId()],
  );

  const result = await database.query('SELECT hub_id FROM hub_identity');
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('hub_identity is empty immediately after an insert; the database is not ours');
  }
  return identityRowSchema.parse(row).hub_id;
}
