import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type HubFrame,
} from '@agentplex/protocol';
import {
  createLogger,
  systemTimers,
  type DialResult,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createSocketPair } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { createFakeBeaconSource } from '../../../apps/hub/src/features/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/features/web/fake-web.js';
import { createSqliteDatabase, type SqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { loadMigrations } from '../../../apps/hub/src/db/migration-files.js';
import { migrate } from '../../../apps/hub/src/db/migrations.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';

/**
 * Web push over the real client socket: the key a browser is told, and the two
 * frames it says back.
 *
 * The unit suites cover the halves -- the table against a migrated schema, the
 * connection against fake seams -- and neither of them can fail the thing this
 * one is for: that a browser which says hello to a *real hub* learns a real
 * key, and that a subscription sent over the real protocol ends up as a row in
 * the real database. The seams between those two halves are exactly where a
 * subscription would be accepted and silently never stored.
 *
 * No server is dialled. Nothing here is about a session: push is the one part
 * of the hub whose whole path runs between a browser and the hub's own disk.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const clock = { now: () => START };

/** A VAPID pair the mint hands back, so a test can name the key it expects. */
const PUBLIC_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls';

/** Two real browsers' endpoints, as `PushSubscription.toJSON()` gives them. */
const ENDPOINT_A = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';
const ENDPOINT_B = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample';

const P256DH =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const AUTH = 'tBHItJI5svbpez7KI4CCXg';

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../apps/hub/migrations', import.meta.url),
);

/** Nothing is paired in this suite, so nothing is ever dialled. */
function dialer(): SocketDialer {
  return {
    dial: async (): Promise<DialResult> => ({ ok: false, problem: 'nothing is paired' }),
  };
}

interface Fleet {
  readonly hub: Hub;
  readonly database: SqliteDatabase;
  readonly cleanup: () => Promise<void>;
}

/**
 * A hub over a real migrated database, with or without a way to push.
 *
 * `push: null` is not a broken hub: it is one served over plaintext, or one
 * whose composition root was given no way to sign. Both are started the same
 * way here so that the difference under test is the one field.
 */
async function startPushHub(canPush: boolean): Promise<Fleet> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-push-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  await migrate(
    database,
    await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem),
    logger,
    clock,
  );

  let minted = 0;
  const hub = await startHub({
    database,
    logger,
    ids: { newId: () => `id-${(minted += 1)}` },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'unused' },
    dialer: dialer(),
    discovery: createFakeBeaconSource(),
    timers: systemTimers,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    migrationFileSystem: nodeMigrationFileSystem,
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    localServer: null,
    // A fixed pair rather than the real mint: what this suite is about is the
    // path from a welcome to a row, and a generated key would make the frame
    // assertion a tautology against whatever the library produced. The one
    // test of the real generator lives beside the wrapper it is.
    //
    // The sender is never called here -- nothing in this suite produces a
    // needs-you edge -- and it throws rather than resolving, so a test that
    // somehow reached a POST to somebody else's service fails loudly.
    push: canPush
      ? {
          generateKeys: () => ({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY }),
          send: () => {
            throw new Error('this suite sends no pushes');
          },
        }
      : null,
    files: createFakeStoreFiles(),
  });

  return {
    hub,
    database,
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A client on a linked socket pair: the ticket exchange has its own suite. */
interface Client {
  /** The welcome this client was sent, read back through the real parser. */
  welcome(): Promise<Extract<HubFrame, { type: 'welcome' }>>;
  /** Sends one frame and waits for whatever the hub says about it. */
  ask(frame: Record<string, unknown>): Promise<HubFrame>;
  /** The unsolicited frames the hub sent, in order. */
  unsolicited(): readonly HubFrame[];
}

function openClient(hub: Hub): Client {
  const { hubEnd, serverEnd } = createSocketPair();
  const received: string[] = [];
  const waiting: (() => void)[] = [];
  serverEnd.onMessage((text) => {
    received.push(text);
    for (const wake of waiting.splice(0)) wake();
  });
  hub.clients.attach(hubEnd);

  const read = (text: string): HubFrame => {
    const parsed = parseTextFrame(parseHubFrame, text);
    if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  };

  let nextId = 0;
  serverEnd.send(
    JSON.stringify({ type: 'hello', id: (nextId += 1), protocolVersion: PROTOCOL_VERSION }),
  );

  const find = async (match: (frame: HubFrame) => boolean): Promise<HubFrame> => {
    for (;;) {
      for (const text of received) {
        const frame = read(text);
        if (match(frame)) return frame;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };

  return {
    async welcome(): Promise<Extract<HubFrame, { type: 'welcome' }>> {
      const frame = await find((candidate) => candidate.type === 'welcome');
      if (frame.type !== 'welcome') throw new Error('unreachable');
      return frame;
    },

    async ask(frame: Record<string, unknown>): Promise<HubFrame> {
      const id = (nextId += 1);
      serverEnd.send(JSON.stringify({ ...frame, id }));
      // A `protocol-error` names nothing, so it is matched on its own: it is
      // what a frame the parser could not read is answered with, and a test
      // waiting for a `replyTo` would wait for ever.
      return find(
        (candidate) =>
          candidate.type === 'protocol-error' ||
          ('replyTo' in candidate && candidate.replyTo === id),
      );
    },

    unsolicited(): readonly HubFrame[] {
      return received.map(read).filter((frame) => !('replyTo' in frame));
    },
  };
}

/** Every endpoint the hub has a row for, read straight out of the table. */
async function storedEndpoints(database: SqliteDatabase): Promise<string[]> {
  const result = await database.query('SELECT endpoint FROM push_subscriptions ORDER BY endpoint');
  return result.rows.map((row) => String((row as { endpoint: unknown }).endpoint));
}

const subscription = (endpoint: string): Record<string, unknown> => ({
  endpoint,
  keys: { p256dh: P256DH, auth: AUTH },
});

let fleet: Fleet | null = null;

afterEach(async () => {
  await fleet?.cleanup();
  fleet = null;
});

describe('a browser asking a real hub to tell it', () => {
  it('is told on the welcome which key to subscribe against', async () => {
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);

    expect(await client.welcome()).toMatchObject({ pushPublicKey: PUBLIC_KEY });
  });

  it('has its subscription stored, as one row', async () => {
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();

    const answer = await client.ask({
      type: 'push-subscribe',
      subscription: subscription(ENDPOINT_A),
    });

    expect(answer).toMatchObject({ type: 'push-subscribed' });
    expect(await storedEndpoints(fleet.database)).toEqual([ENDPOINT_A]);
  });

  it('is one row however many times the same browser subscribes', async () => {
    // A browser re-subscribes on every load of the page that offers it, and
    // the endpoint it gets back is usually the one it already had. A second
    // row would be a second push for one prompt, to one phone.
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();

    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_A) });
    const second = await client.ask({
      type: 'push-subscribe',
      subscription: subscription(ENDPOINT_A),
    });

    expect(second).toMatchObject({ type: 'push-subscribed' });
    expect(await storedEndpoints(fleet.database)).toEqual([ENDPOINT_A]);
  });

  it('keeps the other browsers when one of them subscribes', async () => {
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();

    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_A) });
    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_B) });

    expect(await storedEndpoints(fleet.database)).toEqual([ENDPOINT_A, ENDPOINT_B]);
  });

  it('has the row removed when it unsubscribes, and is told so', async () => {
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();
    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_A) });
    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_B) });

    const answer = await client.ask({ type: 'push-unsubscribe', endpoint: ENDPOINT_A });

    expect(answer).toMatchObject({ type: 'push-unsubscribed' });
    expect(await storedEndpoints(fleet.database)).toEqual([ENDPOINT_B]);
  });

  it('is told yes for an endpoint there was no row for: the browser ends up the same', async () => {
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();

    const answer = await client.ask({ type: 'push-unsubscribe', endpoint: ENDPOINT_B });

    expect(answer).toMatchObject({ type: 'push-unsubscribed' });
    expect(await storedEndpoints(fleet.database)).toEqual([]);
  });

  it('is stopped at the parser when the subscription is not one, and nothing is stored', async () => {
    // A plaintext endpoint, which no push service issues. It is answered with
    // a `protocol-error` rather than a refusal because a subscription is
    // produced by `PushManager.subscribe` and never typed by a person: one
    // that is not a subscription is a broken client, and the parser is where
    // that stops. The row is what matters -- an endpoint the hub could never
    // POST to must not reach the table.
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();

    const answer = await client.ask({
      type: 'push-subscribe',
      subscription: {
        endpoint: 'http://push.example/send/abc',
        keys: { p256dh: P256DH, auth: AUTH },
      },
    });

    expect(answer).toMatchObject({ type: 'protocol-error', code: 'bad-request' });
    expect(await storedEndpoints(fleet.database)).toEqual([]);
  });

  it('never has a needs-you push sent to it on this socket', async () => {
    // The frame that does not exist, asserted over what the socket carried. A
    // push travels to a push service and not down the connection the browser
    // is already holding -- a client on the socket to read one would be a
    // client that did not need the push.
    fleet = await startPushHub(true);
    const client = openClient(fleet.hub);
    await client.welcome();
    await client.ask({ type: 'push-subscribe', subscription: subscription(ENDPOINT_A) });

    for (const frame of client.unsolicited()) {
      expect(frame.type).not.toContain('push');
    }
  });
});

describe('a browser asking a hub that has no push', () => {
  it('is told null rather than an empty key', async () => {
    fleet = await startPushHub(false);
    const client = openClient(fleet.hub);

    expect(await client.welcome()).toMatchObject({ pushPublicKey: null });
  });

  it('mints no key pair at all, rather than one nothing can sign with', async () => {
    fleet = await startPushHub(false);
    openClient(fleet.hub);

    const keys = await fleet.database.query('SELECT public_key FROM push_vapid_keys');
    expect(keys.rows).toEqual([]);
  });

  it('is refused a subscribe in words, and nothing is stored', async () => {
    fleet = await startPushHub(false);
    const client = openClient(fleet.hub);
    await client.welcome();

    const answer = await client.ask({
      type: 'push-subscribe',
      subscription: subscription(ENDPOINT_A),
    });

    expect(answer).toMatchObject({ type: 'refusal', code: 'refused' });
    if (answer.type !== 'refusal') return;
    expect(answer.message).toContain('attention floor');
    expect(await storedEndpoints(fleet.database)).toEqual([]);
  });

  it('is refused an unsubscribe too: it never held the row to remove', async () => {
    fleet = await startPushHub(false);
    const client = openClient(fleet.hub);
    await client.welcome();

    expect(await client.ask({ type: 'push-unsubscribe', endpoint: ENDPOINT_A })).toMatchObject({
      type: 'refusal',
      code: 'refused',
    });
  });
});
