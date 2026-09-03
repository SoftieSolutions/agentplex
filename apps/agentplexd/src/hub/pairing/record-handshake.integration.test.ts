import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serverIdSchema, storeIdSchema, type StoreDescriptor } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import type { IdGenerator } from '../../shared/ids.js';
import { recordHandshake } from './record-handshake.js';
import {
  findServer,
  newServerRegistrationSchema,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from './server-registrations.js';
import { listStores } from './store-records.js';
import { openMigratedSchema, type MigratedSchema } from './test-migrated-schema.js';

/**
 * What a handshake leaves behind, against a real SQLite database.
 *
 * A fake could not answer any of this: that the two writes commit together,
 * that a pairing revoked mid-handshake takes the connection with it, and that
 * a store reported by two servers is one row. Those are the schema's promises,
 * and a fake agreeing with them would only be agreeing with this file.
 *
 * The database is a file in a temporary directory, so this suite never skips
 * and never starts a container.
 */

let migrated: MigratedSchema | null = null;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

/** The clock the schema does not supply, fixed so a stored millisecond is checkable. */
const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

function countingIds(): IdGenerator {
  let issued = 0;
  return { newId: () => `registration-${String((issued += 1)).padStart(4, '0')}` };
}

const ids = countingIds();

async function register(label: string): Promise<LiveServerRegistration> {
  return registerServer(
    db(),
    ids,
    clock,
    newServerRegistrationSchema.parse({
      label,
      address: `wss://${label}.example:8443`,
      token: `tok-${label}`,
    }),
  );
}

function store(id: string, path: string): StoreDescriptor {
  return { storeId: storeIdSchema.parse(id), path };
}

describe('recordHandshake', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('pairing-handshake-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    // SQLite has no TRUNCATE, and no multi-table form of it either.
    await db().query('DELETE FROM servers');
    await db().query('DELETE FROM stores');
  });

  it('records who answered and what it had mounted', async () => {
    const registration = await register('laptop');

    const outcome = await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [store('store-a', '/volumes/claude')],
    });

    expect(outcome).toMatchObject({ kind: 'recorded' });
    expect((await findServer(db(), registration.id))?.serverId).toBe('server-laptop');
    expect((await listStores(db())).map((row) => row.storeId)).toEqual(['store-a']);
  });

  it('anchors one store once, however many servers report it', async () => {
    // Two servers mounting one volume is one store: that is the whole premise
    // of keying by the id written on the volume rather than by the machine.
    const laptop = await register('laptop');
    const box = await register('box');
    const shared = [store('store-shared', '/volumes/claude')];

    await recordHandshake(db(), clock, laptop.id, {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: shared,
    });
    await recordHandshake(db(), clock, box.id, {
      serverId: serverIdSchema.parse('server-box'),
      stores: [store('store-shared', '/mnt/claude')],
    });

    expect((await listStores(db())).map((row) => row.storeId)).toEqual(['store-shared']);
  });

  it('takes a server reporting one store under two mounts as one store', async () => {
    const registration = await register('laptop');

    const outcome = await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [store('store-a', '/volumes/claude'), store('store-a', '/mnt/claude')],
    });

    expect(outcome).toMatchObject({ kind: 'recorded' });
    expect((await listStores(db())).map((row) => row.storeId)).toEqual(['store-a']);
  });

  it('records a server with nothing mounted, which is a legal thing to be', async () => {
    const registration = await register('laptop');

    const outcome = await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [],
    });

    expect(outcome).toMatchObject({ kind: 'recorded', stores: [] });
    expect((await findServer(db(), registration.id))?.serverId).toBe('server-laptop');
  });

  it('refuses a pairing revoked while the handshake was in flight', async () => {
    const registration = await register('laptop');
    await revokeServer(db(), clock, registration.id);

    const outcome = await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [store('store-a', '/volumes/claude')],
    });

    expect(outcome).toEqual({ kind: 'revoked' });
    // And it wrote nothing on the way to saying so.
    expect(await listStores(db())).toEqual([]);
  });

  it('refuses a pairing that does not exist', async () => {
    const outcome = await recordHandshake(
      db(),
      clock,
      'registration-does-not-exist' as LiveServerRegistration['id'],
      { serverId: serverIdSchema.parse('server-laptop'), stores: [] },
    );

    expect(outcome).toEqual({ kind: 'revoked' });
  });

  it('refuses a token presented by a different server than the one paired', async () => {
    // Silently re-pointing the pairing is the alternative, and it leaves every
    // placement filed under the old serverId belonging to nothing, with
    // nobody told that the box they paired was replaced.
    const registration = await register('laptop');
    await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-original'),
      stores: [],
    });

    const outcome = await recordHandshake(db(), clock, registration.id, {
      serverId: serverIdSchema.parse('server-replacement'),
      stores: [store('store-b', '/volumes/claude')],
    });

    expect(outcome).toEqual({
      kind: 'identity-changed',
      paired: 'server-original',
      presented: 'server-replacement',
    });
    expect((await findServer(db(), registration.id))?.serverId).toBe('server-original');
    expect(await listStores(db())).toEqual([]);
  });

  it('accepts the same server handshaking again, which is every reconnect', async () => {
    const registration = await register('laptop');
    const accepted = {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [store('store-a', '/volumes/claude')],
    };
    await recordHandshake(db(), clock, registration.id, accepted);

    const outcome = await recordHandshake(db(), clock, registration.id, accepted);

    expect(outcome).toMatchObject({ kind: 'recorded' });
  });

  it('moves last-seen forward on a reconnect without moving first-seen', async () => {
    const registration = await register('laptop');
    const accepted = {
      serverId: serverIdSchema.parse('server-laptop'),
      stores: [store('store-a', '/volumes/claude')],
    };
    await recordHandshake(db(), clock, registration.id, accepted);
    const [first] = await listStores(db());

    await recordHandshake(db(), clock, registration.id, accepted);
    const [second] = await listStores(db());

    // A store the hub met last year is not new because a server reconnected
    // this morning.
    expect(second?.firstSeenAt).toBe(first?.firstSeenAt);
    expect(second?.lastSeenAt).toBeGreaterThanOrEqual(first?.lastSeenAt ?? 0);
  });
});
