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
 * The two protocol legs, in one process: a client refused on its leg leaves
 * the server on the other leg exactly as it was.
 *
 * The reason the legs were split. With one version for both, a browser built
 * at another number and a server built at another number were the same
 * refusal; now a client at the wrong client leg is refused at hello and the
 * paired server, which speaks only the server leg, stays connected. The fleet
 * is built the way `client-pairing.integration.test.ts` builds it -- the real
 * hub, a real client websocket, and the server's own handshake answering the
 * dial -- because the claim is about the hub keeping two connections apart,
 * which only the whole hub can show.
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
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-protocol-legs-'));
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
  /** Whether the hub has closed this socket. */
  readonly closed: boolean;
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
  let closed = false;
  socket.on('message', (data: Buffer) => text.push(data.toString('utf8')));
  socket.on('close', () => {
    closed = true;
  });
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
    get closed(): boolean {
      return closed;
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

/** A fleet with the server paired over a client and connected. */
async function connectedFleet(): Promise<Fleet> {
  const running = await startFleet();
  fleet = running;
  const pairer = await openClient(running.hub);
  pairer.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  await until(() => reply(pairer, 'welcome') !== undefined, 'the welcome');
  pairer.send({
    type: 'server-pair',
    id: 2,
    label: 'gpu-box-01',
    address: GPU_BOX,
    token: SERVER_TOKEN,
  });
  await until(
    () => running.hub.connections.snapshot().some((report) => report.phase === 'connected'),
    () => `the pairing to connect: ${JSON.stringify(running.hub.connections.snapshot())}`,
  );
  return running;
}

describe('a client refused on the client leg', () => {
  it('is refused naming the client leg, and its socket closes', async () => {
    const running = await connectedFleet();

    const stranger = await openClient(running.hub);
    stranger.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION + 1 });
    await until(() => stranger.closed, 'the refused client to be closed');

    const refusal = reply(stranger, 'refusal');
    expect(refusal?.code).toBe('protocol-version');
    expect(refusal?.message).toContain(`client protocol ${String(CLIENT_PROTOCOL_VERSION)}`);
    expect(reply(stranger, 'welcome')).toBeUndefined();
  });

  it('leaves the paired server connected and its socket open', async () => {
    const running = await connectedFleet();
    const serverSocket = running.live[0];
    if (serverSocket === undefined) throw new Error('the hub dialled no server');
    let serverClosed = false;
    serverSocket.onClose(() => {
      serverClosed = true;
    });

    const stranger = await openClient(running.hub);
    stranger.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION + 1 });
    await until(() => stranger.closed, 'the refused client to be closed');

    expect(running.hub.connections.snapshot().map((report) => report.phase)).toEqual(['connected']);
    expect(serverClosed).toBe(false);
  });

  it('still welcomes a client at the client leg, which sees the server', async () => {
    const running = await connectedFleet();

    const stranger = await openClient(running.hub);
    stranger.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION + 1 });
    await until(() => stranger.closed, 'the refused client to be closed');

    const welcomed = await openClient(running.hub);
    welcomed.send({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
    await until(
      () => welcomed.state?.servers.some((server) => server.phase === 'connected') === true,
      () => `the connected server in machine state: ${welcomed.text.join(' | ')}`,
    );

    expect(reply(welcomed, 'welcome')?.protocolVersion).toBe(CLIENT_PROTOCOL_VERSION);
    expect(welcomed.state?.servers.map((server) => server.label)).toEqual(['gpu-box-01']);
  });
});
