import { z } from 'zod';
import { serverIdSchema, type ServerId } from '@agentplex/protocol';
import type { Queryable } from '../db/database.js';
import type { Clock } from '../../shared/clock.js';
import type { IdGenerator } from '../../shared/ids.js';
import { serverAddressSchema } from './server-address.js';

/**
 * Pairing, as rows: which servers this hub may dial, and with what token.
 *
 * Everything here takes a `Queryable` rather than a `Database`, so a caller
 * that needs several of these in one transaction can have that without this
 * module knowing anything about transactions.
 *
 * Nothing here dials, handshakes or reconnects. This is the layer those are
 * built on, and keeping it ignorant of them is what lets it be tested against
 * a database and nothing else.
 */

/**
 * The hub's own name for a pairing. Distinct from `ServerId`, which is what
 * the server calls itself: this one exists from the moment the user submits
 * the form, and the other only after a handshake has confirmed it.
 */
export const serverRegistrationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .brand<'ServerRegistrationId'>();
export type ServerRegistrationId = z.infer<typeof serverRegistrationIdSchema>;

/**
 * The token the server printed and the user pasted.
 *
 * This parser rejects the empty and the absurd and stops there. How much
 * entropy a token carries is the minting side's business -- the server is what
 * generates it -- and a length rule invented here would only be a rule the
 * thing that mints tokens has never heard of.
 */
export const serverTokenSchema = z.string().trim().min(1).max(4096);

/** What a pairing form submits. The address is parsed, never taken on trust. */
export const newServerRegistrationSchema = z.object({
  label: z.string().trim().min(1).max(200),
  address: serverAddressSchema,
  token: serverTokenSchema,
});
export type NewServerRegistration = z.infer<typeof newServerRegistrationSchema>;

/**
 * Timestamps are epoch milliseconds in the column, on the protocol, and here.
 *
 * There is no conversion to do at any of those boundaries, and the parse still
 * stays: a column being an integer is a claim the database makes, and this is
 * the boundary that stops trusting claims.
 */
const timestampSchema = z.number().int();

const serverRowSchema = z.object({
  id: serverRegistrationIdSchema,
  label: z.string().min(1),
  address: serverAddressSchema,
  server_id: serverIdSchema.nullable(),
  created_at: timestampSchema,
});

/**
 * The two shapes a row can have, parsed rather than assumed.
 *
 * A live pairing has a token; a revoked one does not. That is one fact, and
 * the `servers_token_matches_liveness` constraint is the other half of it: a
 * row that is neither shape cannot be written, and if one ever appears anyway
 * this parser refuses it instead of handing back a registration whose token
 * might be null in the branch that dials.
 */
const liveServerRegistrationSchema = serverRowSchema
  .extend({ token: z.string().min(1), revoked_at: z.null() })
  .transform((row) => ({
    id: row.id,
    label: row.label,
    address: row.address,
    serverId: row.server_id,
    createdAt: row.created_at,
    token: row.token,
    revokedAt: null,
  }));
export type LiveServerRegistration = z.infer<typeof liveServerRegistrationSchema>;

const revokedServerRegistrationSchema = serverRowSchema
  .extend({ token: z.null(), revoked_at: timestampSchema })
  .transform((row) => ({
    id: row.id,
    label: row.label,
    address: row.address,
    serverId: row.server_id,
    createdAt: row.created_at,
    token: null,
    revokedAt: row.revoked_at,
  }));
export type RevokedServerRegistration = z.infer<typeof revokedServerRegistrationSchema>;

const serverRegistrationSchema = z.union([
  liveServerRegistrationSchema,
  revokedServerRegistrationSchema,
]);
export type ServerRegistration = z.infer<typeof serverRegistrationSchema>;

/**
 * Named once. Every statement below selects exactly this, so the parsers above
 * and the reads are the same list rather than two lists that agree today.
 */
const COLUMNS = 'id, label, address, token, server_id, created_at, revoked_at';

/**
 * Records a pairing the user just entered.
 *
 * The id is minted here rather than read back from anywhere: see the migration
 * for why a pairing is not keyed by the server's own id.
 */
export async function registerServer(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  registration: NewServerRegistration,
): Promise<LiveServerRegistration> {
  const result = await database.query(
    `INSERT INTO servers (id, label, address, token, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    [ids.newId(), registration.label, registration.address, registration.token, clock.now()],
  );
  return liveServerRegistrationSchema.parse(result.rows[0]);
}

export interface ListServersOptions {
  /**
   * Revoked pairings are excluded by default: nothing that is about to dial
   * wants them, and the caller that does want them is asking a question about
   * history and can say so.
   */
  readonly includeRevoked?: boolean;
}

/**
 * Every pairing, oldest first.
 *
 * A row that will not parse throws rather than being skipped. The hub is the
 * only writer to this table and every write goes through this module, so an
 * unparseable row is a disagreement between the code and the schema, not a
 * degraded input to be routed around. Dropping it quietly would take a paired
 * server off the user's screen with no explanation anywhere.
 */
export async function listServers(
  database: Queryable,
  options: ListServersOptions = {},
): Promise<readonly ServerRegistration[]> {
  const where = options.includeRevoked === true ? '' : ' WHERE revoked_at IS NULL';
  const result = await database.query(
    `SELECT ${COLUMNS} FROM servers${where} ORDER BY created_at, id`,
  );
  return result.rows.map((row) => serverRegistrationSchema.parse(row));
}

/** One pairing by the hub's id for it, revoked or not. `null` when there is none. */
export async function findServer(
  database: Queryable,
  id: ServerRegistrationId,
): Promise<ServerRegistration | null> {
  const result = await database.query(`SELECT ${COLUMNS} FROM servers WHERE id = ?`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : serverRegistrationSchema.parse(row);
}

/**
 * Revokes one pairing and no others. That is the whole argument for per-server
 * tokens, expressed as a `WHERE id = ?`.
 *
 * The token goes with it. A secret that can no longer authenticate anything
 * should not be sitting in tonight's backup, and clearing it is not encryption
 * wearing a different hat.
 *
 * Already-revoked and never-existed both answer `null`: neither is a live
 * pairing, and a caller that needs to tell them apart has `findServer`.
 */
export async function revokeServer(
  database: Queryable,
  clock: Clock,
  id: ServerRegistrationId,
): Promise<RevokedServerRegistration | null> {
  const result = await database.query(
    `UPDATE servers SET revoked_at = ?, token = NULL
     WHERE id = ? AND revoked_at IS NULL
     RETURNING ${COLUMNS}`,
    [clock.now(), id],
  );
  const row = result.rows[0];
  return row === undefined ? null : revokedServerRegistrationSchema.parse(row);
}

/**
 * Records who answered, once a handshake has said so.
 *
 * Only a live pairing can learn an identity: a revoked one is history, and
 * history does not acquire new facts. `null` therefore means the pairing is
 * gone or revoked -- which, on the handshake path, is exactly the answer that
 * says to drop the connection rather than keep it.
 */
export async function recordServerIdentity(
  database: Queryable,
  id: ServerRegistrationId,
  serverId: ServerId,
): Promise<LiveServerRegistration | null> {
  const result = await database.query(
    `UPDATE servers SET server_id = ?
     WHERE id = ? AND revoked_at IS NULL
     RETURNING ${COLUMNS}`,
    [serverId, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : liveServerRegistrationSchema.parse(row);
}
