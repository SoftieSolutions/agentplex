import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  type ClientFrame,
  type HubFrame,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createFakeTimers,
  createSocketPair,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { serveServerEnd } from './server-end.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeSessionController } from '../../../apps/server/src/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { createExponentialBackoff } from '../../../apps/hub/src/features/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/features/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/features/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/features/fleet-state/fleet-state.js';
import { createProjects } from '../../../apps/hub/src/features/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/features/sessions/sessions.js';

/**
 * A browse, from a client's frame to a directory on another machine and back.
 *
 * The subject is the rule that lets a directory cross the wire at all. A client
 * asks the hub, the hub relays to the one server it names, and that server
 * answers out of the browse roots its own operator configured -- three
 * processes' worth of the path, with only the socket and the disk faked.
 *
 * What it has to establish is not that a listing arrives. It is the four things
 * that make a `directory` field something other than the generic execution
 * surface the v2 rule forbade: a request with no directory on it is what starts
 * a browse, a path under a root is answered, a path outside every root is
 * refused in words, and a machine with no roots refuses everything with that as
 * the reason. `packages/protocol/src/directory.ts` holds the amendment; this is
 * the end-to-end half of it.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = '/srv/work';
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;

/** A disk with a checkout on it, a link out of the root, and a file. */
function disk() {
  return createFakeDirectoryReader({
    directories: {
      [WORK]: [
        { name: 'notes.md', kind: 'file' },
        { name: '.config', kind: 'directory' },
        { name: 'agentplex', kind: 'directory' },
        { name: 'elsewhere', kind: 'other' },
      ],
      [`${WORK}/agentplex`]: [
        { name: 'apps', kind: 'directory' },
        { name: 'package.json', kind: 'file' },
      ],
      [`${WORK}/agentplex/apps`]: [{ name: 'hub', kind: 'directory' }],
      '/etc': [{ name: 'passwd', kind: 'file' }],
    },
    links: { [`${WORK}/elsewhere`]: '/etc' },
  });
}

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  /** Every frame the hub put to the server, as raw text. */
  readonly sentToServer: string[];
  /** The server end of each socket dialled, so a test can make one go away. */
  readonly live: MessageSocket[];
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/**
 * One hub, one paired server, and whatever that server will let anybody browse.
 *
 * The roots are the parameter because they are the subject: the same fleet with
 * a root and without one is the difference between the two halves of this file.
 */
async function start(roots: readonly string[]): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`directory-browse-${suite}`);
  const database = migrated.database;
  const sentToServer: string[] = [];
  const live: MessageSocket[] = [];

  await registerServer(
    database,
    { newId: () => MACHINE },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );

  const dialer: SocketDialer = {
    dial: async (): Promise<DialResult> => {
      const { hubEnd, serverEnd } = createSocketPair();
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores: [],
        providers: [],
        terminals: createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions: createFakeSessionController({ reports: [] }),
        browse: createDirectoryBrowser({ roots: [...roots], reader: disk() }),
        logger,
      });
      live.push(serverEnd);

      const originalSend = hubEnd.send.bind(hubEnd);
      return {
        ok: true,
        socket: {
          ...hubEnd,
          send(text: string): void {
            sentToServer.push(text);
            originalSend(text);
          },
        },
      };
    },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });
  const connections = createServers({
    pairing: createPairing({
      database,
      files: createFakeStoreFiles(),
      ids: { newId: () => 'unused' },
      clock,
      logger,
    }),
    dialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
  });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions: createSessions({ state, connections, logger }),
    projects: createProjects({ state, connections, logger }),
  });

  await connections.sync();

  return { state, clients, connections, sentToServer, live };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Client {
  say(frame: ClientFrame): Promise<void>;
  reply(id: number): HubFrame;
}

/** A client on a socket, read back through the parser a client would use. */
async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const readAll = (): HubFrame[] =>
    socket.sent.map((text) => {
      const parsed = parseTextFrame(parseHubFrame, text);
      if (!parsed.ok) throw new Error(`the hub sent an unparseable frame: ${parsed.reason}`);
      return parsed.value;
    });

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      socket.receive(JSON.stringify(frame));
      // An answer that crosses to another machine and back takes more than one
      // turn of the loop.
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    reply(id: number): HubFrame {
      const answer = readAll().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

async function connected(roots: readonly string[]): Promise<void> {
  harness = await start(roots);
  await until(
    () =>
      held()
        .connections.snapshot()
        .every((report) => report.phase === 'connected'),
    'the server to be connected',
  );
}

afterEach(async () => {
  await harness?.connections.stop();
  harness?.clients.stop();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('browsing a server that has a browse root', () => {
  beforeEach(async () => {
    await connected([WORK]);
  });

  it('lists the roots when the request names no directory', async () => {
    // How a browse begins: the client does not know what that machine allows
    // and must not have to guess.
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: null });

    expect(client.reply(2)).toEqual({
      type: 'directory-listing',
      replyTo: 2,
      directory: null,
      roots: [WORK],
      entries: [{ name: WORK, kind: 'directory' }],
      truncated: false,
    });
  });

  it('descends into a directory under the root, hidden entries and all', async () => {
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: WORK });

    expect(client.reply(2)).toMatchObject({
      type: 'directory-listing',
      directory: WORK,
      entries: [
        { name: '.config', kind: 'directory' },
        { name: 'agentplex', kind: 'directory' },
        // The link out of the root is listed and is named for what it is, so
        // the picker can show it without offering to follow it.
        { name: 'elsewhere', kind: 'other' },
        { name: 'notes.md', kind: 'file' },
      ],
      truncated: false,
    });
  });

  it('walks two levels down, which is what a picker actually does', async () => {
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: WORK });
    await client.say({
      type: 'directory-list',
      id: 3,
      server: MACHINE,
      directory: `${WORK}/agentplex/apps`,
    });

    expect(client.reply(3)).toMatchObject({
      directory: `${WORK}/agentplex/apps`,
      entries: [{ name: 'hub', kind: 'directory' }],
    });
  });

  it('refuses a path outside the root, in words the client can render', async () => {
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: '/etc' });

    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    if (answer.type !== 'refusal') return;
    expect(answer.message).toContain('/etc');
    expect(answer.message).toContain('not under a directory');
  });

  it('refuses a link inside the root that points out of it', async () => {
    // The case the containment rule exists for: textually under the root, and
    // the kernel says otherwise.
    const client = await attach();
    await client.say({
      type: 'directory-list',
      id: 2,
      server: MACHINE,
      directory: `${WORK}/elsewhere`,
    });

    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused' });
    // And it does not tell the asker where the link went, which is a fact about
    // a disk they were just refused.
    if (answer.type !== 'refusal') return;
    expect(answer.message).not.toContain('/etc');
  });

  it('refuses a server this hub has not paired without asking anybody', async () => {
    const client = await attach();
    const before = held().sentToServer.length;
    await client.say({
      type: 'directory-list',
      id: 2,
      server: 'registration-nowhere' as ServerRegistrationId,
      directory: null,
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', code: 'refused' });
    expect(held().sentToServer.length).toBe(before);
  });

  it('puts a directory on the instruction and nothing else that names a program', async () => {
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: WORK });

    const instructions = held()
      .sentToServer.map((text) => {
        const parsed = parseTextFrame(parseHubToServerFrame, text);
        if (!parsed.ok)
          throw new Error(`an unparseable frame reached the server: ${parsed.reason}`);
        return parsed.value;
      })
      .filter((frame) => frame.type === 'directory-list');

    // The hub-to-server leg does not name the machine again: the hub already
    // picked the connection, and a field saying which server this is would be
    // the hub telling a server which server it is.
    expect(instructions).toEqual([
      { type: 'directory-list', id: expect.any(Number), directory: WORK },
    ]);
  });
});

describe('browsing a server with no browse roots configured', () => {
  beforeEach(async () => {
    await connected([]);
  });

  it('refuses even the roots request, and names the setting to change', async () => {
    // The default a server ships with, and the direction that does not
    // over-claim: a machine nobody has given a root browses nothing and says so
    // rather than quietly offering `/`.
    const client = await attach();
    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: null });

    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    if (answer.type !== 'refusal') return;
    expect(answer.message).toContain('AGENTPLEX_BROWSE_ROOTS');
    expect(answer.message).toContain('--browse-root');
  });
});

describe('browsing a machine that has gone away', () => {
  it('refuses with a sentence naming it, rather than waiting out an instruction timeout', async () => {
    // The one fact the server cannot supply: whether the hub still holds a
    // connection to ask down. A pairing that is up and then unreachable keeps
    // its row, so the refusal can name the machine somebody may go and switch
    // on -- which is what makes this different from naming a server nobody
    // paired.
    await connected([WORK]);
    const client = await attach();

    held().live[0]?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'stale'),
      'the server to go stale',
    );

    await client.say({ type: 'directory-list', id: 2, server: MACHINE, directory: null });
    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused' });
    if (answer.type !== 'refusal') return;
    expect(answer.message).toContain('attic');
    expect(answer.message).toContain('not connected');
  });
});
