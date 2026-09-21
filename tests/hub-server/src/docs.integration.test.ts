import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  docNameSchema,
  parseHubFrame,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  type ClientFrame,
  type HubFrame,
  type NodeId,
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
import {
  createFakeProjectFiles,
  type FakeProjectFiles,
} from '../../../apps/server/src/fake-project-files.js';
import { createProjectDocs } from '../../../apps/server/src/project-docs.js';
import { createFakeSessionController } from '../../../apps/server/src/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/features/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/features/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/features/attention/fake-attention.js';
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
import { createFakeTerminal } from '../../../apps/hub/src/features/terminal/fake-terminal.js';
import { createFakeCatalogue } from '../../../apps/hub/src/features/catalogue/fake-catalogue.js';
import { createDocs } from '../../../apps/hub/src/features/docs/docs.js';
import { createProjects } from '../../../apps/hub/src/features/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/features/sessions/sessions.js';

/**
 * A document, from a client's frame to a file on another machine and back.
 *
 * The subject is the split the docs feature exists to hold: the hub owns the
 * index and the machine owns the bytes. A client names a project node, the hub
 * turns that into the directory out of its own rows, the server derives its
 * own folder from that directory and writes the file -- three processes'
 * worth, with only the socket and the disk faked.
 *
 * What it has to establish is what a unit test cannot. That the directory on
 * the wire came from the hub's database and never from the client. That the
 * file the server actually wrote is under that server's data root and nowhere
 * near the working tree the project names. That a save replaces the file and a
 * read returns what the last save put there. And that a document on a machine
 * the hub has lost is a refusal naming the machine rather than a stale copy
 * served from a hub that has none.
 *
 * Listing is not here, and that is not an omission: `docs.list` reads the hub's
 * index and asks no machine anything, so there is no leg for this file to
 * exercise. It is covered where it lives, in
 * `apps/hub/src/features/docs/docs.integration.test.ts`, including the case
 * this file cannot reach -- a document listed while the machine holding it is
 * switched off.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = '/srv/work/agentplex';
const DATA_ROOT = '/var/lib/agentplex';
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  /** Every frame the hub put to the server, as raw text. */
  readonly sentToServer: string[];
  /** The server end of each socket dialled, so a test can make one go away. */
  readonly live: MessageSocket[];
  /** The disk under that machine's project file store. */
  readonly disk: FakeProjectFiles;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** One hub, one paired server, and one in-memory disk under that server. */
async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`docs-relay-${suite}`);
  const database = migrated.database;
  const sentToServer: string[] = [];
  const live: MessageSocket[] = [];
  // One disk for the machine rather than one per connection: a project folder
  // is the machine's, so a document survives the socket that wrote it.
  const disk = createFakeProjectFiles();

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
        // The real rules over that one disk. Nothing about a document is faked
        // above the filesystem: the folder derivation, the name parser and the
        // reserved note are the server's own.
        docs: createProjectDocs({ dataRoot: DATA_ROOT, files: disk, logger }),
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
  const pairing = createPairing({
    database,
    files: createFakeStoreFiles(),
    ids: { newId: () => 'unused' },
    clock,
    logger,
  });
  const connections = createServers({
    pairing,
    dialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
  });

  let minted = 0;
  const ids = { newId: () => `node-${String((minted += 1))}` };
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    // No catalogue is running here: what this file follows is a document from a
    // frame to a file and back, and nothing in it draws a tree.
    onTreeChanged: () => undefined,
  });
  const docs = createDocs({
    database,
    ids,
    clock,
    state,
    projects,
    connections,
    logger,
    onTreeChanged: () => undefined,
  });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    // Not the subject: a document is what this file is about, and the fake is
    // what a suite stands on when a seam is not its subject.
    catalogue: createFakeCatalogue(),
    // Nothing in this file starts a session, so the start handle the feature
    // now mints has nothing to be unique against -- the same `unused` the rest
    // of this harness hands an id source it never reads back.
    sessions: createSessions({
      state,
      projects,
      connections,
      ids: { newId: () => 'unused' },
      logger,
      // And so nothing here has a task to record either.
      onStarted: async () => undefined,
    }),
    // The same two seams `hub.ts` hands the broadcast. A broadcast built
    // without them would be a different broadcast.
    // Not this suite's subject; the fake keeps the rows in memory and answers
    // the two frames the way the real feature does.
    attention: createFakeAttention(),
    // Nothing in this file answers an approval; a broadcast built without the
    // seam would be a different broadcast from the one the hub runs.
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    pairing,
    syncServers: () => connections.sync(),
    projects,
    docs,
    // Nothing here subscribes to a terminal; the relay is here because a
    // broadcast without one is not the broadcast the hub builds.
    terminal: createFakeTerminal(),
    // No push: none of these suites is about it, and a broadcast whose push
    // seam is absent is not the broadcast the hub builds.
    push: null,
  });

  await connections.sync();

  return { state, clients, connections, sentToServer, live, disk };
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

async function connected(): Promise<void> {
  harness = await start();
  await until(
    () =>
      held()
        .connections.snapshot()
        .every((report) => report.phase === 'connected'),
    'the server to be connected',
  );
}

/** A client with a project made through it, and the node id the hub minted. */
async function withProject(): Promise<{ client: Client; projectId: NodeId }> {
  const client = await attach();
  await client.say({ type: 'project-create', id: 2, name: 'agentplex', directory: WORK });
  const created = client.reply(2);
  if (created.type !== 'project-created') throw new Error('the project was refused');
  return { client, projectId: created.nodeId };
}

afterEach(async () => {
  await held().connections.stop();
  harness?.clients.stop();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('writing and reading a document through the hub', () => {
  beforeEach(async () => {
    await connected();
  });

  it('writes the file under the server data root, from a frame that named no path', async () => {
    const { client, projectId } = await withProject();

    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: '# Plan\n\n- read the failing test\n',
    });

    expect(client.reply(3)).toMatchObject({ type: 'doc-created', replyTo: 3 });

    // The file is under the server's own data root, and nowhere under the
    // working tree the project names. That is the whole of what the project
    // file store promised: a document is the server's file, not an edit to
    // somebody's checkout.
    const written = [...held().disk.written.keys()];
    expect(written.every((path) => path.startsWith(`${DATA_ROOT}/`))).toBe(true);
    expect(written.some((path) => path.startsWith(WORK))).toBe(false);
    const plan = written.find((path) => path.endsWith('/plan.md'));
    expect(plan).toBeDefined();
    expect(held().disk.written.get(plan ?? '')).toBe('# Plan\n\n- read the failing test\n');
  });

  it('sends the project directory to the server, and the client sent no directory at all', async () => {
    const { client, projectId } = await withProject();

    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'x',
    });

    const writes = held()
      .sentToServer.map((text) => {
        const parsed = parseTextFrame(parseHubToServerFrame, text);
        if (!parsed.ok)
          throw new Error(`an unparseable frame reached the server: ${parsed.reason}`);
        return parsed.value;
      })
      .filter((frame) => frame.type === 'doc-write');

    // The directory is on the frame because the amended rule allows exactly
    // that -- and it came out of the hub's `projects` row, which is the half
    // of the rule that matters: the client named a node, and the only party
    // that turned one into a path holds the database.
    expect(writes).toEqual([
      { type: 'doc-write', id: expect.any(Number), directory: WORK, name: 'plan.md', content: 'x' },
    ]);
  });

  it('replaces the file on a save and reads back what the last save put there', async () => {
    const { client, projectId } = await withProject();
    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'first',
    });
    const created = client.reply(3);
    if (created.type !== 'doc-created') throw new Error('the create was refused');

    await client.say({ type: 'doc-save', id: 4, nodeId: created.nodeId, content: 'second' });
    await client.say({ type: 'doc-open', id: 5, nodeId: created.nodeId });

    const saved = client.reply(4);
    expect(saved).toMatchObject({ type: 'doc-saved', replyTo: 4 });
    expect(client.reply(5)).toMatchObject({
      type: 'doc-content',
      replyTo: 5,
      content: 'second',
    });
    // A write replaces the document whole. There is no patch form, so there is
    // no version the hub could hold that the machine never saw entire.
    const plan = [...held().disk.written.keys()].find((path) => path.endsWith('/plan.md'));
    expect(held().disk.written.get(plan ?? '')).toBe('second');
  });

  it('carries the machine’s write time on both replies, not the hub’s clock', async () => {
    const { client, projectId } = await withProject();
    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'first',
    });
    const created = client.reply(3);
    if (created.type !== 'doc-created') throw new Error('the create was refused');

    await client.say({ type: 'doc-save', id: 4, nodeId: created.nodeId, content: 'second' });
    await client.say({ type: 'doc-open', id: 5, nodeId: created.nodeId });

    const saved = client.reply(4);
    const opened = client.reply(5);
    if (saved.type !== 'doc-saved' || opened.type !== 'doc-content') {
      throw new Error('the save or the open was refused');
    }
    // The fake disk counts its writes rather than reading a clock, which is
    // what makes this assertion mean something: the hub's own clock is fixed
    // at START, and neither reply carries it.
    expect(saved.updatedAt).not.toBe(START);
    expect(opened.updatedAt).toBe(saved.updatedAt);
  });

  it('refuses a second document of that name before it overwrites the first', async () => {
    const { client, projectId } = await withProject();
    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'the original',
    });

    await client.say({
      type: 'doc-create',
      id: 4,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'the accident',
    });

    expect(client.reply(4)).toMatchObject({ type: 'refusal', replyTo: 4, code: 'refused' });
    const plan = [...held().disk.written.keys()].find((path) => path.endsWith('/plan.md'));
    expect(held().disk.written.get(plan ?? '')).toBe('the original');
  });

  it('refuses a project this hub does not have, without asking the machine', async () => {
    const client = await attach();
    const before = held().sentToServer.length;

    await client.say({
      type: 'doc-create',
      id: 2,
      projectId: 'node-nowhere' as NodeId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: 'x',
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
    expect(held().sentToServer.length).toBe(before);
  });

  it('refuses the folder’s own note by name, in the server’s words', async () => {
    const { client, projectId } = await withProject();

    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('project.json'),
      content: '{}',
    });

    const answer = client.reply(3);
    expect(answer).toMatchObject({ type: 'refusal', replyTo: 3, code: 'refused' });
    if (answer.type !== 'refusal') return;
    // The protocol cannot know the folder has a note: it is a name that parses
    // like any other document. The one place that knows is the server, and its
    // sentence is what the client renders.
    expect(answer.message).toContain('project.json');
  });
});

describe('a document on a machine that has gone away', () => {
  beforeEach(async () => {
    await connected();
  });

  it('refuses the open with a sentence naming the machine, and holds no copy to serve', async () => {
    const { client, projectId } = await withProject();
    await client.say({
      type: 'doc-create',
      id: 3,
      projectId,
      server: MACHINE,
      name: docNameSchema.parse('plan.md'),
      content: '# Plan\n',
    });
    const created = client.reply(3);
    if (created.type !== 'doc-created') throw new Error('the create was refused');

    held().live[0]?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'stale'),
      'the server to go stale',
    );

    await client.say({ type: 'doc-open', id: 4, nodeId: created.nodeId });

    const answer = client.reply(4);
    expect(answer).toMatchObject({ type: 'refusal', replyTo: 4, code: 'refused', holder: null });
    if (answer.type !== 'refusal') return;
    // The cost of never holding the content, said out loud to the person who
    // asked: the machine that wrote it is the only one that can answer.
    expect(answer.message).toContain('attic');
    expect(answer.message).toContain('holds no copy');
  });
});
