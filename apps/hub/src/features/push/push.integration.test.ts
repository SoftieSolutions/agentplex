import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import {
  createPush,
  pushEndpointSchema,
  type Push,
  type PushSubscription,
  type VapidKeyGenerator,
} from './push.js';

/**
 * The push feature's storage, against a real migrated schema.
 *
 * Over the migrations rather than a fake database, because everything worth
 * asserting here is SQL: that the key pair's table admits one row and the
 * second mint therefore does nothing, and that two subscriptions from one
 * browser are one row. A fake that agreed with whatever it was handed would
 * agree with an upsert that quietly wrote a second key pair.
 */

const START = 1_756_000_000_000;

/** A real browser's endpoint, as `PushSubscription.toJSON()` hands it over. */
const ENDPOINT_A = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';
const ENDPOINT_B = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample';

/** 65 bytes of uncompressed P-256 point, base64url, as a browser sends it. */
const P256DH =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const AUTH = 'tBHItJI5svbpez7KI4CCXg';

let migrated: MigratedSchema | null = null;
let logged: LogRecord[] = [];
let minted = 0;
let now = START;

const logger = createLogger('debug', (record) => logged.push(record));

function db(): MigratedSchema['database'] {
  if (migrated === null) throw new Error('no database: beforeEach did not run');
  return migrated.database;
}

/**
 * A generator that hands back a different, well-formed pair every call, so a
 * test can tell "the stored pair came back" from "a fresh pair was minted".
 */
const countingKeys: VapidKeyGenerator = () => {
  minted += 1;
  return {
    publicKey: `public-key-${minted}`.padEnd(87, 'x'),
    privateKey: `private-key-${minted}`.padEnd(43, 'x'),
  };
};

function feature(generateKeys: VapidKeyGenerator = countingKeys): Push {
  return createPush({ database: db(), clock: { now: () => now }, logger, generateKeys });
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint: pushEndpointSchema.parse(endpoint), keys: { p256dh: P256DH, auth: AUTH } };
}

describe('the push feature', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('push-probe');
    logged = [];
    minted = 0;
    now = START;
  });

  afterEach(async () => {
    await migrated?.close();
    migrated = null;
  });

  it('mints a key pair on the first load and hands the same one back on the next', async () => {
    const first = feature();
    await first.load();
    const publicKey = first.publicKey();
    expect(publicKey).not.toBeNull();
    expect(minted).toBe(1);

    // A second instance over the same file: this is the restart, and a hub
    // that minted again would be a hub every subscribed browser has just
    // stopped accepting pushes from.
    const second = feature();
    await second.load();
    expect(second.publicKey()).toBe(publicKey);

    const rows = await db().query('SELECT count(*) AS n FROM push_vapid_keys');
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('refuses a second key pair row rather than making one unlikely', async () => {
    await feature().load();
    await expect(
      db().query(
        `INSERT INTO push_vapid_keys (only_row, public_key, private_key, created_at)
         VALUES (2, 'other-public', 'other-private', ?)`,
        [START],
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('keeps the private half to itself: it is on no interface and in no log line', async () => {
    const push = feature();
    await push.load();

    const stored = await db().query<{ private_key: string }>(
      'SELECT private_key FROM push_vapid_keys',
    );
    const privateKey = 'private-key-1'.padEnd(43, 'x');
    expect(stored.rows[0]?.private_key).toBe(privateKey);

    // The interface offers no way to ask for it, which is why the sending in
    // the next step happens inside this feature rather than beside it: a key
    // pair whose private half reaches a log line or a caller is a key pair
    // that has to be rotated, and rotating it silences every browser at once.
    expect(Object.keys(push).sort()).toEqual([
      'load',
      'publicKey',
      'subscribe',
      'subscriptions',
      'unsubscribe',
    ]);
    expect(JSON.stringify(logged)).not.toContain(privateKey);
  });

  it('stamps the mint off the injected clock and not off whichever machine ran it', async () => {
    now = START + 90_000;
    await feature().load();
    const rows = await db().query('SELECT only_row, created_at FROM push_vapid_keys');
    expect(rows.rows).toEqual([{ only_row: 1, created_at: START + 90_000 }]);
  });

  it('says it has no key rather than claiming one when the generator cannot mint', async () => {
    const push = feature(() => {
      throw new Error('no entropy on this box');
    });
    await expect(push.load()).resolves.toBeUndefined();
    // Null and never an empty string: a hub with no key has to be able to say
    // so, and the client's whole job on reading it is to stay on the in-page
    // floor rather than offer a control that cannot work.
    expect(push.publicKey()).toBeNull();
  });

  it('leaves an unreadable key row alone rather than minting over it', async () => {
    await db().query(
      `INSERT INTO push_vapid_keys (public_key, private_key, created_at)
       VALUES ('not base64url ..', 'nor is this ..', ?)`,
      [START],
    );

    const push = feature();
    await push.load();
    expect(push.publicKey()).toBeNull();

    // The row is still the operator's to look at. Overwriting it would destroy
    // the one copy of a key pair that a half-working deploy might still be
    // able to use.
    const rows = await db().query('SELECT public_key FROM push_vapid_keys');
    expect(rows.rows).toEqual([{ public_key: 'not base64url ..' }]);
  });

  it('keeps one row per endpoint however many times a browser subscribes', async () => {
    const push = feature();
    await push.subscribe(subscription(ENDPOINT_A));
    await push.subscribe(subscription(ENDPOINT_A));
    expect(await push.subscriptions()).toEqual([subscription(ENDPOINT_A)]);
  });

  it('refreshes the keys of a browser that re-subscribes on the same endpoint', async () => {
    const push = feature();
    await push.subscribe(subscription(ENDPOINT_A));
    const rotated: PushSubscription = {
      endpoint: pushEndpointSchema.parse(ENDPOINT_A),
      keys: { p256dh: P256DH.replace('BNcR', 'BOtH'), auth: 'ZZZItJI5svbpez7KI4CCXg' },
    };
    now = START + 60_000;
    await push.subscribe(rotated);

    expect(await push.subscriptions()).toEqual([rotated]);
    // The row remembers when this browser first subscribed. A refresh of the
    // keys is not a new subscription, and the age of a row is what a later
    // sweep of dead endpoints would read.
    const rows = await db().query('SELECT created_at FROM push_subscriptions');
    expect(rows.rows).toEqual([{ created_at: START }]);
  });

  it('removes one subscription and leaves the others', async () => {
    const push = feature();
    await push.subscribe(subscription(ENDPOINT_A));
    await push.subscribe(subscription(ENDPOINT_B));
    await push.unsubscribe(pushEndpointSchema.parse(ENDPOINT_A));
    expect(await push.subscriptions()).toEqual([subscription(ENDPOINT_B)]);
  });

  it('removes nothing quietly when the endpoint was never subscribed', async () => {
    const push = feature();
    await push.subscribe(subscription(ENDPOINT_A));
    await expect(push.unsubscribe(pushEndpointSchema.parse(ENDPOINT_B))).resolves.toBeUndefined();
    expect(await push.subscriptions()).toHaveLength(1);
  });

  it('lets one unreadable row cost itself rather than every subscription the hub holds', async () => {
    const push = feature();
    await push.subscribe(subscription(ENDPOINT_A));
    // A row nothing here wrote: a plaintext endpoint, which is what a
    // hand-edited database or a migration gone wrong looks like from up here.
    await db().query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES ('http://push.example/broken', ?, ?, ?)`,
      [P256DH, AUTH, START],
    );

    expect(await push.subscriptions()).toEqual([subscription(ENDPOINT_A)]);
  });
});

describe('what a subscription is allowed to say', () => {
  it('takes an https endpoint', () => {
    expect(pushEndpointSchema.parse(ENDPOINT_A)).toBe(ENDPOINT_A);
  });

  it('refuses a plaintext endpoint, which no push service offers', () => {
    expect(pushEndpointSchema.safeParse('http://push.example/x').success).toBe(false);
  });

  it('refuses an endpoint that is not a URL at all', () => {
    expect(pushEndpointSchema.safeParse('fcm.googleapis.com/send/x').success).toBe(false);
  });

  it('refuses credentials in the endpoint, which are a secret nothing rotates', () => {
    expect(pushEndpointSchema.safeParse('https://u:p@push.example/x').success).toBe(false);
  });

  it('refuses an endpoint longer than the bound', () => {
    expect(pushEndpointSchema.safeParse(`https://push.example/${'x'.repeat(4_000)}`).success).toBe(
      false,
    );
  });
});
