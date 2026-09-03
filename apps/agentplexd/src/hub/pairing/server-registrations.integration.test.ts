import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serverIdSchema, serverRegistrationIdSchema, type ServerId } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import {
  findServer,
  listServers,
  newServerRegistrationSchema,
  recordServerConnected,
  recordServerIdentity,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from './server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from './test-migrated-schema.js';
import type { IdGenerator } from '../../shared/ids.js';

/**
 * Pairing against a real SQLite database.
 *
 * Nothing here can be asserted against a fake, because most of what is being
 * asserted is the schema's: that a revoked pairing cannot keep its token, that
 * two live pairings cannot claim the same server, that a re-pairing can take
 * back the id its revoked predecessor held. Those are constraints, and a fake
 * that agreed with them would only be agreeing with this file.
 *
 * The database is a file in a temporary directory, so this suite never skips
 * and never starts a container: it runs on a laptop, in CI and in the image,
 * always.
 */

let migrated: MigratedSchema | null = null;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

/**
 * The clock the schema does not supply. Fixed, so a stored millisecond is a value
 * a test can assert on -- and so every `created_at` in a run is identical,
 * which leaves the list ordering entirely to the counter ids below rather than
 * to whether two inserts landed in the same millisecond.
 */
const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

/**
 * Ids from a counter, not `randomUUID`. Two registrations a millisecond apart
 * can share a `created_at`, and the list is ordered by `created_at, id`; a
 * counter makes the tie break in insertion order instead of at random, so an
 * ordering assertion means something on every run rather than on most.
 */
function countingIds(): IdGenerator {
  let issued = 0;
  return { newId: () => `registration-${String((issued += 1)).padStart(4, '0')}` };
}

const ids = countingIds();

async function register(label: string, token: string): Promise<LiveServerRegistration> {
  return registerServer(
    db(),
    ids,
    clock,
    newServerRegistrationSchema.parse({
      label,
      address: `wss://${label}.example:8443`,
      token,
    }),
  );
}

function serverId(value: string): ServerId {
  return serverIdSchema.parse(value);
}

/** The token as the column actually holds it, bypassing every parser above it. */
async function storedToken(id: string): Promise<string | null> {
  const result = await db().query<{ token: string | null }>(
    'SELECT token FROM servers WHERE id = ?',
    [id],
  );
  return result.rows[0]?.token ?? null;
}

describe('server registrations', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('pairing-servers-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    // SQLite has no TRUNCATE. An unqualified DELETE is its documented
    // equivalent and this table holds a handful of rows per test.
    await db().query('DELETE FROM servers');
  });

  it('records a pairing with the token the user typed', async () => {
    const registration = await register('laptop', 'tok-laptop');

    expect(registration.label).toBe('laptop');
    expect(registration.address).toBe('wss://laptop.example:8443');
    expect(registration.token).toBe('tok-laptop');
    expect(registration.revokedAt).toBeNull();
    // Nobody has handshaken yet, so the server has not said who it is. That is
    // a different fact from a server without an id, and it is why the pairing
    // is not keyed by one.
    expect(registration.serverId).toBeNull();
    expect(registration.createdAt).toBeGreaterThan(0);
  });

  it('stores the token in the clear, exactly as the schema says it does', async () => {
    // This assertion exists to be broken. Encrypting a credential the hub has
    // to reproduce on every dial, with a key on the same disk, is theatre; if
    // somebody adds it anyway, they should have to come here and read why.
    const registration = await register('laptop', 'tok-in-the-clear');

    expect(await storedToken(registration.id)).toBe('tok-in-the-clear');
  });

  it('lists live pairings oldest first', async () => {
    await register('first', 'tok-1');
    await register('second', 'tok-2');
    await register('third', 'tok-3');

    expect((await listServers(db())).map((row) => row.label)).toEqual(['first', 'second', 'third']);
  });

  it('revokes one pairing and leaves every other token untouched', async () => {
    // The whole argument for per-server tokens, as an assertion.
    const laptop = await register('laptop', 'tok-laptop');
    const ec2 = await register('ec2', 'tok-ec2');

    await revokeServer(db(), clock, laptop.id);

    expect(await storedToken(laptop.id)).toBeNull();
    expect(await storedToken(ec2.id)).toBe('tok-ec2');
    expect((await listServers(db())).map((row) => row.label)).toEqual(['ec2']);
  });

  it('remembers a revoked pairing rather than deleting it', async () => {
    const laptop = await register('laptop', 'tok-laptop');

    const revoked = await revokeServer(db(), clock, laptop.id);

    expect(revoked?.revokedAt).toBeGreaterThan(0);
    expect(revoked?.token).toBeNull();
    expect((await listServers(db(), { includeRevoked: true })).map((row) => row.label)).toEqual([
      'laptop',
    ]);
  });

  it('answers nothing when a pairing is revoked twice', async () => {
    const laptop = await register('laptop', 'tok-laptop');
    await revokeServer(db(), clock, laptop.id);

    expect(await revokeServer(db(), clock, laptop.id)).toBeNull();
  });

  it('answers nothing when revoking a pairing that never existed', async () => {
    expect(
      await revokeServer(db(), clock, serverRegistrationIdSchema.parse('never-paired')),
    ).toBeNull();
  });

  it('records the id a handshake reported', async () => {
    const laptop = await register('laptop', 'tok-laptop');

    const identified = await recordServerIdentity(db(), laptop.id, serverId('server-abc'));

    expect(identified?.serverId).toBe('server-abc');
    expect((await findServer(db(), laptop.id))?.serverId).toBe('server-abc');
  });

  it('refuses to give a revoked pairing an identity', async () => {
    const laptop = await register('laptop', 'tok-laptop');
    await revokeServer(db(), clock, laptop.id);

    expect(await recordServerIdentity(db(), laptop.id, serverId('server-abc'))).toBeNull();
  });

  it('refuses two live pairings claiming to be the same server', async () => {
    const first = await register('first', 'tok-1');
    const second = await register('second', 'tok-2');
    await recordServerIdentity(db(), first.id, serverId('server-abc'));

    await expect(recordServerIdentity(db(), second.id, serverId('server-abc'))).rejects.toThrow();
  });

  it('lets a re-paired server take back the id its revoked pairing held', async () => {
    // Rotating a token is exactly this sequence, so a plain UNIQUE across all
    // rows would make rotation impossible rather than merely awkward.
    const old = await register('laptop', 'tok-old');
    await recordServerIdentity(db(), old.id, serverId('server-abc'));
    await revokeServer(db(), clock, old.id);

    const fresh = await register('laptop', 'tok-new');
    const identified = await recordServerIdentity(db(), fresh.id, serverId('server-abc'));

    expect(identified?.serverId).toBe('server-abc');
    expect(identified?.token).toBe('tok-new');
  });

  it('records when a live pairing connected, and starts out never having', async () => {
    const registration = await register('laptop', 'tok-1');
    expect(registration.lastConnectedAt).toBeNull();

    const connected = await recordServerConnected(db(), clock, registration.id);

    expect(connected?.lastConnectedAt).toBe(NOW);
  });

  it('will not record a connection to a revoked pairing', async () => {
    // A pairing the operator withdrew is history, and history does not acquire
    // new facts. It is the same guard `recordServerIdentity` has, for the same
    // reason: the supervisor takes `null` here as "stop".
    const registration = await register('laptop', 'tok-1');
    await revokeServer(db(), clock, registration.id);

    expect(await recordServerConnected(db(), clock, registration.id)).toBeNull();
  });

  it('answers nothing for a pairing id nobody has', async () => {
    expect(await findServer(db(), serverRegistrationIdSchema.parse('never-paired'))).toBeNull();
  });

  it('refuses a row whose liveness and token disagree', async () => {
    // The parser reads two shapes and the constraint writes two shapes; this
    // is the test that they are the same two.
    //
    // Getting an impossible row in takes a different tool here. SQLite has no
    // `ALTER TABLE ... DROP CONSTRAINT`, and its DDL being transactional is
    // beside the point when there is no DDL to run: `ignore_check_constraints`
    // suspends the check for this connection instead. It is a pragma rather
    // than a statement, so it is not covered by the rollback and has to be put
    // back by hand -- hence the `finally`. The row itself still goes in inside
    // a transaction, so the rollback is what keeps the hole out of the tests
    // that follow.
    await db().query('PRAGMA ignore_check_constraints = ON');
    try {
      await expect(
        db().transaction(async (tx) => {
          await tx.query(
            `INSERT INTO servers (id, label, address, token, created_at, revoked_at)
             VALUES ('impossible', 'laptop', 'wss://laptop.example:8443', 'tok', ?, ?)`,
            [NOW, NOW],
          );
          return listServers(tx, { includeRevoked: true });
        }),
      ).rejects.toThrow();
    } finally {
      await db().query('PRAGMA ignore_check_constraints = OFF');
    }

    expect(await listServers(db(), { includeRevoked: true })).toEqual([]);
  });
});
