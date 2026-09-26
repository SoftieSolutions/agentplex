import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  serverIdSchema,
  storeIdSchema,
  type HubFrame,
  type MachineState,
} from '@agentplex/protocol';
import {
  createLogger,
  systemTimers,
  type DialResult,
  type MessageSocket,
} from '@agentplex/node-shared';
import { createSocketPair } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles, readyProvider } from '@agentplex/providers/testing';
import { createFakeSessionController } from '../../../apps/server/src/sessions/fake-session-controller.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createFakeTerminals } from '../../../apps/server/src/terminal/fake-terminals.js';
import { createSqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { createFakeBeaconSource } from '../../../apps/hub/src/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/web/fake-web.js';
import {
  CLIENT_SOCKET_PATH,
  CLIENT_TICKET_PATH,
} from '../../../apps/hub/src/client-auth/client-auth.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';
import { serveServerEnd } from './server-end.js';

/**
 * Pairing, the whole way through: a browser types a token and a machine the hub
 * had never heard of is connected a moment later.
 *
 * Everything here is the real thing except the wire between the hub and the
 * server and the clock. The client is a real websocket that exchanged a real
 * ticket, the frames go through the protocol's own parsers, the pairing is a
 * row in a migrated SQLite file, and what answers the dial is
 * `serveHubConnection` -- the server's own code, doing the server's own
 * handshake against the token the client just typed.
 *
 * The two questions it exists to answer are the ones no unit test can: that a
 * pairing made over a socket is dialled without a restart, and that the dial
 * stops when the same client unpairs it. Both used to be true only of a hub
 * that had been restarted, because nothing client-reachable reached
 * `registerServer` at all.
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';
const GPU_BOX = 'wss://gpu-box.example:8443';
/** What the server printed and the person pasted. It travels once, inbound. */
const SERVER_TOKEN = 'the-token-the-server-printed';

const logger = createLogger('error', () => {});

interface Fleet {
  readonly hub: Hub;
  /** Every address the hub has dialled, in order. */
  readonly dialled: readonly string[];
  /** The server end of each live connection, so a test can watch one close. */
  readonly live: readonly MessageSocket[];
  cleanup(): Promise<void>;
}

async function startFleet(): Promise<Fleet> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-pairing-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  const dialled: string[] = [];
  const live: MessageSocket[] = [];
  let nextTicket = 0;

  const hub = await startHub({
    database,
    logger,
    ids: { newId: () => `registration-${String(dialled.length + 1)}` },
    clock: { now: () => 1_756_000_000_000 },
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => `ticket-${(nextTicket += 1)}` },
    dialer: {
      dial: async (address: string): Promise<DialResult> => {
        dialled.push(address);
        if (address !== GPU_BOX) return { ok: false, problem: 'connection refused' };
        const { hubEnd, serverEnd } = createSocketPair();
        serveServerEnd(serverEnd, {
          sessions: createFakeSessionController(),
          terminals: createFakeTerminals().terminals,
          machineLoad: createFakeMachineLoadReader(),
          identity: { serverId: serverIdSchema.parse('server-gpu'), token: SERVER_TOKEN },
          stores: [{ storeId: storeIdSchema.parse('store-universe'), path: '/mnt/universe' }],
          providers: [readyProvider('claude')],
          logger,
        });
        live.push(serverEnd);
        return { ok: true, socket: hubEnd };
      },
    },
    discovery: createFakeBeaconSource(),
    // The real ones, and the one place this file departs from the suites
    // around it. What is under test is a broadcast reaching a client that is
    // already attached, and a broadcast is scheduled on this seam: fake timers
    // would mean reading the state by opening a second client, which is a
    // different question from the one being asked.
    timers: systemTimers,
    migrationsDirectory: fileURLToPath(new URL('../../../apps/hub/migrations', import.meta.url)),
    migrationFileSystem: nodeMigrationFileSystem,
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    // The pairing nobody types is not this file's subject: what is under test
    // is the one somebody does.
    localServer: null,
    // No push: this suite is not about it, and the two seams it needs are a
    // cryptographic mint and a POST to somebody else's service.
    push: null,
    files: createFakeStoreFiles(),
  });

  return {
    hub,
    get dialled(): readonly string[] {
      return dialled;
    },
    get live(): readonly MessageSocket[] {
      return live;
    },
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

interface Client {
  send(frame: unknown): void;
  /** Every frame the hub has sent, parsed by the parser a browser would use. */
  readonly received: readonly HubFrame[];
  /** The characters, for the question that is about characters and not fields. */
  readonly text: readonly string[];
  /** The newest state the hub published, or `null` before the first one. */
  readonly state: MachineState | null;
}

async function openClient(hub: Hub): Promise<Client> {
  const exchange = await fetch(`http://${HOST}:${hub.port}${CLIENT_TICKET_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  const issued = (await exchange.json()) as { ticket: string };
  const socket = new WebSocket(
    `ws://${HOST}:${hub.port}${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(issued.ticket)}`,
  );

  const text: string[] = [];
  socket.on('message', (data: Buffer) => text.push(data.toString('utf8')));
  await new Promise<void>((resolve) => socket.on('open', () => resolve()));

  const client: Client = {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    get text(): readonly string[] {
      return text;
    },
    get received(): readonly HubFrame[] {
      return text.map((line) => {
        const parsed = parseTextFrame(parseHubFrame, line);
        if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
        return parsed.value;
      });
    },
    get state(): MachineState | null {
      const states = client.received.filter((frame) => frame.type === 'machine-state');
      return states.at(-1)?.state ?? null;
    },
  };
  return client;
}

async function until(predicate: () => boolean, what: string | (() => string)): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

function reply<Type extends HubFrame['type']>(
  client: Client,
  type: Type,
): Extract<HubFrame, { type: Type }> | undefined {
  return client.received.find(
    (frame): frame is Extract<HubFrame, { type: Type }> => frame.type === type,
  );
}

let fleet: Fleet | null = null;

afterEach(async () => {
  await fleet?.cleanup();
  fleet = null;
});

async function pairedFleet(): Promise<{ running: Fleet; client: Client }> {
  const running = await startFleet();
  fleet = running;
  const client = await openClient(running.hub);
  client.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  await until(() => reply(client, 'welcome') !== undefined, 'the welcome');

  client.send({
    type: 'server-pair',
    id: 2,
    label: 'gpu-box-01',
    address: GPU_BOX,
    token: SERVER_TOKEN,
  });
  await until(
    () => reply(client, 'server-paired') !== undefined,
    () => `the pairing to be answered: ${client.text.join(' | ')}`,
  );
  return { running, client };
}

describe('a client pairing a server', () => {
  it('is answered, and the hub dials the machine without being restarted', async () => {
    const { running, client } = await pairedFleet();

    const paired = reply(client, 'server-paired');
    expect(paired?.registrationId).toBe('registration-1');

    await until(
      () => running.hub.connections.snapshot().some((report) => report.phase === 'connected'),
      () => `the new pairing to connect: ${JSON.stringify(running.hub.connections.snapshot())}`,
    );
    expect(running.dialled).toEqual([GPU_BOX]);
  });

  it('publishes the machine to every client, connected and with what it reported', async () => {
    const { running, client } = await pairedFleet();

    await until(
      () => client.state?.servers.some((server) => server.phase === 'connected') === true,
      () => `a state with the server connected: ${JSON.stringify(client.state)}`,
    );

    const [server] = client.state?.servers ?? [];
    expect(server).toMatchObject({
      registrationId: 'registration-1',
      label: 'gpu-box-01',
      // The address the row is drawn with, which is the pairing screen's way of
      // telling two machines with the same label apart.
      address: GPU_BOX,
      serverId: 'server-gpu',
      phase: 'connected',
    });
    expect(server?.stores).toEqual(['store-universe']);
    expect(running.hub.state.snapshot().stores.map((view) => view.storeId)).toEqual([
      'store-universe',
    ]);
  });

  it('never says the token again, on any frame it sends afterwards', async () => {
    // The rule the whole surface rests on, asserted over the characters rather
    // than over a field: the reply, every machine state, every log line the
    // client can see. A field assertion would cover only the shapes somebody
    // thought to check.
    const { client } = await pairedFleet();
    await until(
      () => client.state?.servers.some((server) => server.phase === 'connected') === true,
      'the server to connect',
    );

    expect(client.text.length).toBeGreaterThan(2);
    for (const line of client.text) expect(line).not.toContain(SERVER_TOKEN);
  });

  it('stops dialling the moment the same client unpairs it', async () => {
    const { running, client } = await pairedFleet();
    await until(
      () => running.hub.connections.snapshot().some((report) => report.phase === 'connected'),
      'the server to connect',
    );
    const connection = running.live.at(-1);
    let ended = false;
    connection?.onClose(() => {
      ended = true;
    });

    client.send({ type: 'server-unpair', id: 3, registrationId: 'registration-1' });
    await until(
      () => reply(client, 'server-unpaired') !== undefined,
      () => `the unpairing to be answered: ${client.text.join(' | ')}`,
    );

    // The connection is dropped, the supervisor holds nothing, and the rows go
    // with it: a revoked pairing's sessions are claims nothing stands behind.
    await until(() => ended, 'the connection to the server to end');
    expect(running.hub.connections.snapshot()).toEqual([]);
    await until(
      () => client.state?.servers.length === 0,
      () => `a state with no servers: ${JSON.stringify(client.state)}`,
    );

    // And nothing dials it again, however long the retries would have run.
    const dialsBefore = running.dialled.length;
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(running.dialled.length).toBe(dialsBefore);
  });

  it('refuses a second unpair of the same registration, without closing the socket', async () => {
    const { client } = await pairedFleet();
    client.send({ type: 'server-unpair', id: 3, registrationId: 'registration-1' });
    await until(() => reply(client, 'server-unpaired') !== undefined, 'the unpairing');

    client.send({ type: 'server-unpair', id: 4, registrationId: 'registration-1' });
    await until(
      () => client.received.some((frame) => frame.type === 'refusal'),
      () => `a refusal: ${client.text.join(' | ')}`,
    );

    expect(reply(client, 'refusal')).toMatchObject({ replyTo: 4, code: 'refused' });
  });

  it('refuses an address it will not dial, and dials nothing', async () => {
    const running = await startFleet();
    fleet = running;
    const client = await openClient(running.hub);
    client.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
    await until(() => reply(client, 'welcome') !== undefined, 'the welcome');

    client.send({
      type: 'server-pair',
      id: 2,
      label: 'gpu-box-01',
      // Plaintext to somewhere that is not this machine: the one thing a typed
      // address may never be, because the token would cross a network in the
      // clear.
      address: 'ws://gpu-box.example:8443',
      token: SERVER_TOKEN,
    });
    await until(
      () => client.received.some((frame) => frame.type === 'refusal'),
      () => `a refusal: ${client.text.join(' | ')}`,
    );

    const refusal = reply(client, 'refusal');
    expect(refusal).toMatchObject({ replyTo: 2, code: 'bad-request' });
    expect(refusal?.type === 'refusal' ? refusal.message : '').toContain('wss://');
    expect(running.dialled).toEqual([]);
    expect(running.hub.connections.snapshot()).toEqual([]);
  });
});
