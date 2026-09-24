import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import {
  pushEndpointSchema,
  nodeIdSchema,
  serverAddressSchema,
  sessionIdSchema,
  storeIdSchema,
  type PushSubscription,
  type ServerRegistrationId,
  type SessionDescriptor,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createFleetState } from '../fleet-state/fleet-state.js';
import { createAttentionEdge } from './attention-edge.js';
import {
  PUSH_FAN_OUTS_IN_FLIGHT_MAX,
  createPush,
  type Push,
  type PushDelivery,
  type PushEvent,
  type PushOutcome,
  type PushSender,
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

/**
 * What the sender does about one endpoint: answer, throw, or hang until the
 * test says otherwise. The third is how a slow push service is written down
 * here -- a promise nobody resolves rather than a wait nobody can afford.
 */
type Answer = PushOutcome | Error | Promise<PushOutcome>;

/** Every delivery the feature handed to the sender, in the order it did. */
let delivered: PushDelivery[] = [];
/** What the sender answers, by endpoint. Anything unnamed is delivered. */
let answers = new Map<string, Answer>();

const recordingSender: PushSender = (delivery) => {
  delivered.push(delivery);
  const answer = answers.get(delivery.subscription.endpoint);
  if (answer instanceof Error) return Promise.reject(answer);
  if (answer instanceof Promise) return answer;
  return Promise.resolve(answer ?? { kind: 'delivered' });
};

/** A send in flight, and the handle a test finishes it with. */
function hanging(): { readonly promise: Promise<PushOutcome>; finish(outcome: PushOutcome): void } {
  let finish: (outcome: PushOutcome) => void = () => {};
  const promise = new Promise<PushOutcome>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (outcome) => finish(outcome) };
}

/**
 * Lets everything already queued run. Not a wait: a turn of the loop, which is
 * what a test needs when the thing under test is a promise nobody is awaiting.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function feature(
  generateKeys: VapidKeyGenerator = countingKeys,
  send: PushSender = recordingSender,
  database: MigratedSchema['database'] = db(),
): Push {
  return createPush({ database, clock: { now: () => now }, logger, generateKeys, send });
}

/**
 * The real database, with every statement matching `matching` rejecting.
 *
 * The real one underneath rather than a fake, because what the tests using it
 * ask is what the feature does when SQL that ordinarily works stops working --
 * a disk that went away, a connection closed under it at shutdown -- and a
 * fake that answered everything would not be the same question.
 */
function databaseRejecting(matching: string): MigratedSchema['database'] {
  const real = db();
  return {
    ...real,
    query: async (sql, params) => {
      if (sql.includes(matching)) throw new Error(`no such connection: ${matching}`);
      return real.query(sql, params);
    },
  };
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint: pushEndpointSchema.parse(endpoint), keys: { p256dh: P256DH, auth: AUTH } };
}

/** One needs-you edge, in the four fields the detector is allowed to pass on. */
const EDGE: Extract<PushEvent, { kind: 'session' }> = {
  kind: 'session',
  storeId: storeIdSchema.parse('store-work'),
  sessionId: sessionIdSchema.parse('session-a'),
  provider: 'claude',
  status: 'awaiting-permission',
};

/**
 * The three things a descriptor knows that a lock screen may not be told.
 *
 * Distinctive strings rather than plausible ones, so that the assertion they
 * are used in is a search of the actual payload and not a comparison of two
 * literals written in the same file.
 */
const TELLING_TITLE = 'merge the billing migration';
const TELLING_CWD = '/srv/work/acme-billing';
const TELLING_BRANCH = 'spike/price-rules';

const REGISTRATION = 'registration-workshop' as ServerRegistrationId;

function tellingSession(status: SessionDescriptor['status'], updatedAt: number): SessionDescriptor {
  return {
    storeId: EDGE.storeId,
    sessionId: EDGE.sessionId,
    provider: 'claude',
    status,
    updatedAt,
    cwd: TELLING_CWD,
    branch: TELLING_BRANCH,
    title: TELLING_TITLE,
    uncommitted: null,
  };
}

/**
 * An edge as the hub actually produces one: off a real row, through the real
 * detector, from a session whose descriptor is as talkative as a real one.
 *
 * The reducer and the detector are here rather than a literal because what is
 * being asked is whether a descriptor's fields can reach a notification, and
 * the answer has to be read out of the thing that assembles the event rather
 * than out of the test's own idea of it.
 */
function edgeFromATellingRow(): PushEvent {
  const caught: PushEvent[] = [];
  const state = createFleetState({ logger });
  const edge = createAttentionEdge({ notify: (event) => caught.push(event), logger });
  state.subscribe((snapshot) => edge.observe(snapshot));

  state.applyConnection({
    registrationId: REGISTRATION,
    label: 'workshop',
    address: serverAddressSchema.parse('wss://workshop.example:8443'),
    serverId: null,
    phase: 'connected',
    providers: [readyProvider()],
    stores: [EDGE.storeId],
    connectedSince: START,
    staleSince: null,
    lastConnectedAt: START,
    failedAttempts: 0,
    problem: null,
    staleReason: null,
    draining: null,
  });
  const report = (session: SessionDescriptor): void => {
    state.applySessions({
      registrationId: REGISTRATION,
      storeId: EDGE.storeId,
      sessions: [session],
      holding: [],
      reportedAt: START,
    });
  };
  // The first report seeds the store, so the prompt has to arrive after it --
  // which is also the only order in which this hub ever pushes.
  report(tellingSession('working', START));
  report(tellingSession('awaiting-permission', START + 1));

  const event = caught[0];
  if (event === undefined) throw new Error('no edge: the detector said nothing about that row');
  return event;
}

describe('the push feature', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('push-probe');
    logged = [];
    minted = 0;
    now = START;
    delivered = [];
    answers = new Map();
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
      'notify',
      'publicKey',
      'stop',
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

  it('says it has no key rather than throwing when the database cannot answer', async () => {
    // `load` is documented as never throwing, and `boot.ts` awaits it before
    // the hub is served: a rejection here would be a hub that refuses to start
    // because the one optional thing it does is unavailable.
    const push = feature(countingKeys, recordingSender, databaseRejecting('push_vapid_keys'));
    await expect(push.load()).resolves.toBeUndefined();
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

describe('the fan-out', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('push-fan-out');
    logged = [];
    minted = 0;
    now = START;
    delivered = [];
    answers = new Map();
  });

  afterEach(async () => {
    await migrated?.close();
    migrated = null;
  });

  /** A loaded feature with both browsers subscribed, which is the usual case. */
  async function loadedWithTwoBrowsers(): Promise<Push> {
    const push = feature();
    await push.load();
    await push.subscribe(subscription(ENDPOINT_A));
    await push.subscribe(subscription(ENDPOINT_B));
    logged = [];
    return push;
  }

  it('sends one push to every subscription the hub holds', async () => {
    const push = await loadedWithTwoBrowsers();

    await push.notify(EDGE);

    expect(delivered.map((one) => one.subscription.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);
  });

  it('signs as this hub, with the pair the feature keeps to itself', async () => {
    const push = await loadedWithTwoBrowsers();

    await push.notify(EDGE);

    // The public half is the one every subscription was made against, and the
    // private half reaches the sender and nothing else: it is still on no
    // interface and in no log line.
    expect(delivered[0]?.vapid).toEqual({
      publicKey: 'public-key-1'.padEnd(87, 'x'),
      privateKey: 'private-key-1'.padEnd(43, 'x'),
    });
    expect(JSON.stringify(logged)).not.toContain('private-key-1');
  });

  it('says the provider and the status words, and carries the two ids to tap on', async () => {
    const push = await loadedWithTwoBrowsers();

    await push.notify(EDGE);

    expect(JSON.parse(delivered[0]?.payload ?? 'null')).toEqual({
      title: 'claude',
      body: 'awaiting permission',
      data: { storeId: 'store-work', sessionId: 'session-a' },
    });
  });

  it('says which run is waiting at which node, and carries the graph to tap on', async () => {
    const push = await loadedWithTwoBrowsers();

    await push.notify({
      kind: 'graphRun',
      graph: nodeIdSchema.parse('node-graph-release'),
      number: 38,
      node: 'Ship it',
    });

    expect(JSON.parse(delivered[0]?.payload ?? 'null')).toEqual({
      title: 'graph run',
      body: 'run #38 is waiting at Ship it',
      data: { graph: 'node-graph-release' },
    });
  });

  it('puts nothing on a lock screen that was not asked for', async () => {
    const push = await loadedWithTwoBrowsers();

    // Not the hand-built `EDGE` above: the event is taken off a real row,
    // through the real detector, because the question is whether anything a
    // descriptor carries can reach a payload and a literal written in this
    // file could only ever agree with itself. The row's title, directory and
    // branch are distinctive strings, and the assertion is over the bytes the
    // sender was handed -- so a field added to either the event or the
    // template fails here rather than arriving on somebody's phone.
    await push.notify(edgeFromATellingRow());

    const payload = delivered[0]?.payload ?? '';
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(['body', 'data', 'title']);
    for (const secret of [TELLING_TITLE, TELLING_CWD, TELLING_BRANCH]) {
      expect(payload).not.toContain(secret);
    }
  });

  it('forgets a subscription the push service says has gone', async () => {
    const push = await loadedWithTwoBrowsers();
    // What a 404 or a 410 means: this browser is never coming back. A cleared
    // site, an uninstalled app, a registration the service expired.
    answers.set(ENDPOINT_A, { kind: 'gone' });

    await push.notify(EDGE);

    expect(await push.subscriptions()).toEqual([subscription(ENDPOINT_B)]);
  });

  it('lets a failed send cost that subscription and no other', async () => {
    const push = await loadedWithTwoBrowsers();
    answers.set(ENDPOINT_A, { kind: 'failed', problem: 'too many requests' });

    await push.notify(EDGE);

    // Both were tried, and both are still here: somebody else's rate limit is
    // not a reason to stop pushing to a browser that is perfectly reachable.
    expect(delivered).toHaveLength(2);
    expect(await push.subscriptions()).toHaveLength(2);
    expect(JSON.stringify(logged)).toContain('too many requests');
  });

  it('survives a sender that throws rather than answering', async () => {
    const push = await loadedWithTwoBrowsers();
    answers.set(ENDPOINT_A, new Error('socket hang up'));

    await expect(push.notify(EDGE)).resolves.toBeUndefined();

    expect(delivered.map((one) => one.subscription.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);
    expect(await push.subscriptions()).toHaveLength(2);
  });

  it('does nothing and says nothing when this hub has no key pair', async () => {
    const push = feature(() => {
      throw new Error('no entropy on this box');
    });
    await push.load();
    await push.subscribe(subscription(ENDPOINT_A));
    logged = [];

    await push.notify(EDGE);

    // Not a warning per change, which on a busy fleet is a log nobody can
    // read. A hub with no key pair has already said so once, at load.
    expect(delivered).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('stays resolved when the subscriptions cannot be read at all', async () => {
    // The contract this feature's one caller stands on: the hub floats
    // `notify` from inside the fleet state's publish, and there is no
    // `unhandledRejection` handler over it. A rejection here is not a push
    // that did not arrive, it is the daemon going away.
    const push = feature(countingKeys, recordingSender, databaseRejecting('SELECT endpoint'));
    await push.load();
    await push.subscribe(subscription(ENDPOINT_A));
    logged = [];

    await expect(push.notify(EDGE)).resolves.toBeUndefined();

    expect(delivered).toEqual([]);
    expect(JSON.stringify(logged)).toContain('no such connection');
  });

  it('stays resolved when forgetting a gone subscription fails', async () => {
    const push = feature(countingKeys, recordingSender, databaseRejecting('DELETE FROM'));
    await push.load();
    await push.subscribe(subscription(ENDPOINT_A));
    await push.subscribe(subscription(ENDPOINT_B));
    logged = [];
    answers.set(ENDPOINT_A, { kind: 'gone' });

    await expect(push.notify(EDGE)).resolves.toBeUndefined();

    // A delete that could not run costs that subscription its removal and
    // nothing else: the other browser is still told.
    expect(delivered.map((one) => one.subscription.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);
    expect(JSON.stringify(logged)).toContain('no such connection');
  });

  it('touches no database once the hub has stopped, even mid-send', async () => {
    const push = await loadedWithTwoBrowsers();
    const send = hanging();
    answers.set(ENDPOINT_A, send.promise);

    // The shutdown path: `hub.stop()` runs while a send is in flight, and
    // `boot.ts` closes the database the moment it returns.
    const fanOut = push.notify(EDGE);
    await settle();
    push.stop();

    // The service answers after all that, and says the subscription is dead --
    // which is the one outcome that would otherwise write to the database.
    send.finish({ kind: 'gone' });
    await expect(fanOut).resolves.toBeUndefined();
    await settle();

    // The delete never ran. Had it run here it would have run against a
    // connection `boot.ts` closes the moment `hub.stop()` returns, and the
    // rejection would have been on nobody's promise.
    const rows = await db().query('SELECT count(*) AS n FROM push_subscriptions');
    expect(rows.rows[0]).toEqual({ n: 2 });
  });

  it('lets a browser whose service has stopped answering hold up nobody else', async () => {
    const push = await loadedWithTwoBrowsers();
    // A push service that accepted the POST and never answered. Written as a
    // promise nobody resolves rather than as a wait, so this costs a turn of
    // the loop instead of the sender's whole timeout.
    const quiet = hanging();
    answers.set(ENDPOINT_A, quiet.promise);

    const fanOut = push.notify(EDGE);
    await settle();

    // Sequentially, the second browser was not tried until the first one's
    // timeout had run out -- which is a notification nobody got because
    // somebody else's push service was having a bad minute.
    expect(delivered.map((one) => one.subscription.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);

    quiet.finish({ kind: 'delivered' });
    await expect(fanOut).resolves.toBeUndefined();
  });

  it('drops edges rather than piling up fan-outs a stuck service is holding', async () => {
    const push = await loadedWithTwoBrowsers();
    const quiet = hanging();
    answers.set(ENDPOINT_A, quiet.promise);
    answers.set(ENDPOINT_B, quiet.promise);

    // One edge more than the hub will hold at once. Nothing upstream bounds
    // these: a fleet coming back produces them as fast as servers report.
    const started: Promise<void>[] = [];
    for (let edge = 0; edge <= PUSH_FAN_OUTS_IN_FLIGHT_MAX; edge += 1) {
      started.push(push.notify(EDGE));
    }
    await settle();

    // Every fan-out inside the cap is sending; the one past it was dropped
    // rather than queued behind a service that is not answering.
    expect(delivered).toHaveLength(PUSH_FAN_OUTS_IN_FLIGHT_MAX * 2);
    expect(logged.filter((record) => record.message.includes('in flight'))).toHaveLength(1);

    quiet.finish({ kind: 'delivered' });
    await Promise.all(started);

    // What the pile-up cost, once, when it drains -- rather than a line per
    // dropped edge, which would be longest when somebody is trying to read it.
    expect(logged.filter((record) => record.message.includes('drained'))).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ dropped: 1 }) }),
    ]);
  });

  it('starts no new fan-out once the hub has stopped', async () => {
    const push = await loadedWithTwoBrowsers();
    push.stop();

    await expect(push.notify(EDGE)).resolves.toBeUndefined();

    expect(delivered).toEqual([]);
  });

  it('does nothing and says nothing when nobody has subscribed', async () => {
    const push = feature();
    await push.load();
    logged = [];

    await push.notify(EDGE);

    expect(delivered).toEqual([]);
    expect(logged).toEqual([]);
  });
});

// What an endpoint and a subscription may be is the protocol's rule now, and
// its cases moved with it to `packages/protocol/src/push.test.ts`. A test that
// stayed here would be this app asserting somebody else's parser.
