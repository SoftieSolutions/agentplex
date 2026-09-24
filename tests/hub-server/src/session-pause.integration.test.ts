import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseHubFrame,
  parseHubToServerFrame,
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type HubToServerFrame,
  type ServerToHubFrame,
  type ServerRegistrationId,
  type SessionHolder,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createFakeTimers,
  createSocketPair,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import {
  createFakeProviderAdapter,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readyProvider,
} from '@agentplex/providers/testing';
import { createProviderRegistry, type ProviderFiles } from '@agentplex/providers';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { serveServerEnd } from './server-end.js';
import { forbiddenKeysIn } from './frame-keys.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/features/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/features/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/features/attention/fake-attention.js';
import { createFakeCatalogue } from '../../../apps/hub/src/features/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/features/docs/fake-docs.js';
import { createFakeTerminal } from '../../../apps/hub/src/features/terminal/fake-terminal.js';
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
 * Pausing a session, from a client's frame to the terminal on another machine
 * and back to every client's holder.
 *
 * Everything but the socket, the disk and the fork is the shipped code: the
 * real terminal manager over a fake pty, the real session controller, a real
 * handshake in both directions, both parsers, the real reducer and the real
 * relay on the sessions feature. That is what makes the assertions here worth
 * having over the unit tests beside each part. A fake controller answers a
 * pause with whatever the test handed it, so a suite over one would prove that
 * a frame travels and nothing about what a pause is; here the word on the
 * holder is the manager's own, read off the terminal it holds.
 *
 * What this suite exists to say: that a pause asked mid-turn comes back as
 * `requested` and is promoted to `paused` by the scan that sees the boundary,
 * with the client learning each step from the holder on the next machine
 * state; that the process is never touched; that a resume lifts it; and that
 * each way this can fail is a sentence rather than a silence.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;
const STORE: StoreDescriptor = { storeId: WORK, path: '/volumes/work' };
const SESSION = sessionIdSchema.parse('session-build');
const RECORD = `${STORE.path}/claude/sessions/${SESSION}.json`;

/**
 * The session's record on the machine's disk, live rather than a snapshot.
 *
 * The fake adapter derives the status off `signal`, exactly as a real one
 * derives it off a transcript: `progressing` as of now is `working`, and
 * `awaiting-input` is a turn boundary. The test moves the session from one to
 * the other by rewriting the record, which is what an agent finishing its turn
 * looks like to a scan.
 */
function record(signal: 'progressing' | 'awaiting-input'): string {
  return JSON.stringify({ signal, updatedAt: START, cwd: STORE.path });
}

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  /** The hub's timers, which the client broadcast coalesces on. */
  readonly timers: FakeTimers;
  /** The machine's disk, rewritten mid-test to end the agent's turn. */
  readonly disk: Record<string, string>;
  readonly live: MessageSocket[];
  readonly dialled: { readonly hubEnd: FakeMessageSocket; readonly serverEnd: FakeMessageSocket }[];
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** One hub, one paired machine running the shipped terminal path over a fake pty. */
async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`session-pause-${suite}`);
  const database = migrated.database;
  const live: MessageSocket[] = [];
  const dialled: { hubEnd: FakeMessageSocket; serverEnd: FakeMessageSocket }[] = [];
  const disk: Record<string, string> = { [RECORD]: record('progressing') };
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: disk }).readFile(path),
    listDirectory: (path) => createFakeProviderFiles({ files: disk }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: disk }).readFileTail(path, maxBytes),
  };
  const ptys = createFakePtyFactory();
  const terminals = createTerminalManager({
    supervisor: createPtySupervisor({
      pty: ptys,
      clock,
      ids: { newId: () => `run-${String(ptys.ptys.length)}` },
      environment: {},
    }),
    clock,
  });

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
        stores: [STORE],
        providers: [readyProvider('claude')],
        terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions: createSessionController({
          stores: [STORE],
          providers: createProviderRegistry([
            createFakeProviderAdapter({ provider: 'claude', files }),
          ]),
          terminals,
          workingTree: createFakeWorkingTree(),
          browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
          approvals: null,
          clock,
          logger,
        }),
        logger,
      });
      live.push(serverEnd);
      dialled.push({ hubEnd, serverEnd });
      serverEnd.onMessage(() => {});
      return { ok: true, socket: hubEnd };
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
    onReport: (report) => {
      state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      });
    },
  });

  const ids = { newId: () => 'start-1' };
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
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
    sessions: createSessions({
      state,
      projects,
      connections,
      ids,
      logger,
      onStarted: async () => undefined,
    }),
    attention: createFakeAttention(),
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    push: null,
    pairing,
    syncServers: () => connections.sync(),
    projects,
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    terminal: createFakeTerminal(),
  });

  await connections.sync();

  return { state, clients, connections, terminals, ptys, timers, disk, live, dialled };
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
  said(): ClientFrame[];
  heard(): HubFrame[];
  /** The holder on the session's row, as of the last machine state this client was sent. */
  holder(): SessionHolder | null;
}

function parsedFrame<T>(parser: (raw: unknown) => { ok: boolean }, text: string): T {
  const result = parseTextFrame(parser as never, text) as
    { ok: true; value: T } | { ok: false; reason: string };
  if (!result.ok) throw new Error(`an unparseable frame reached a peer: ${result.reason}`);
  return result.value;
}

async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);
  const outbound: string[] = [];

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      const text = JSON.stringify(frame);
      outbound.push(text);
      socket.receive(text);
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // The broadcast coalesces changes on a timer, and the timers here are
      // fake: firing them is what a real hub does a few milliseconds later.
      held().timers.fireAll();
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    reply(id: number): HubFrame {
      const answer = client.heard().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
    said(): ClientFrame[] {
      return outbound.map((text) => parsedFrame(parseClientFrame, text));
    },
    heard(): HubFrame[] {
      return socket.sent.map((text) => parsedFrame(parseHubFrame, text));
    },
    holder(): SessionHolder | null {
      // The newest state this client was sent, and never the reducer's own
      // snapshot: what the test is about is what a client can see.
      const states = client.heard().filter((frame) => frame.type === 'machine-state');
      const latest = states.at(-1);
      if (latest === undefined || latest.type !== 'machine-state') return null;
      for (const store of latest.state.stores) {
        for (const row of store.sessions) {
          if (row.descriptor.sessionId === SESSION) return row.holder;
        }
      }
      return null;
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

/** A client, and the session running on the machine through a start it sent. */
async function running(): Promise<Client> {
  const client = await attach();
  await client.say({
    type: 'session-start',
    id: 2,
    storeId: WORK,
    sessionId: SESSION,
    provider: 'claude',
    prompt: null,
    server: null,
    project: null,
  });
  expect(client.reply(2)).toMatchObject({ type: 'session-started', sessionId: SESSION });
  await until(() => client.holder() !== null, 'the client to see the session held');
  return client;
}

beforeEach(async () => {
  harness = await start();
  await until(
    () =>
      held()
        .connections.snapshot()
        .every((report) => report.phase === 'connected'),
    'the server to be connected',
  );
  await until(
    () => held().state.snapshot().stores.length > 0,
    'the machine to report what it has in that store',
  );
});

afterEach(async () => {
  await held().connections.stop();
  harness?.clients.stop();
  held().terminals.closeAll();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('pausing a session through the hub', () => {
  it('records a pause against a working session and promotes it at the boundary, on the holder', async () => {
    const client = await running();
    expect(client.holder()).toEqual({ server: MACHINE, stoppable: false, pause: 'none' });

    await client.say({ type: 'session-pause', id: 3, storeId: WORK, sessionId: SESSION });

    // Mid-turn: the receipt says the pause is requested, and so does the holder
    // every client is sent -- because the server reported the store before it
    // answered, the two cannot disagree.
    expect(client.reply(3)).toEqual({
      type: 'session-paused',
      replyTo: 3,
      storeId: WORK,
      sessionId: SESSION,
      server: MACHINE,
      pause: 'requested',
    });
    expect(client.holder()).toEqual({ server: MACHINE, stoppable: false, pause: 'requested' });
    // And nothing has been killed: a pause is not a stop.
    expect(held().ptys.last?.kills).toBe(0);

    // The agent finishes its turn. The scan that sees that is what promotes
    // the request, and a second pause -- idempotent -- is the instruction that
    // provokes a scan here, exactly as a store change would in production.
    held().disk[RECORD] = record('awaiting-input');
    await client.say({ type: 'session-pause', id: 4, storeId: WORK, sessionId: SESSION });

    expect(client.reply(4)).toMatchObject({ type: 'session-paused', pause: 'paused' });
    expect(client.holder()).toEqual({ server: MACHINE, stoppable: true, pause: 'paused' });
    expect(held().terminals.holder({ storeId: WORK, sessionId: SESSION })?.pause).toBe('paused');
    expect(held().ptys.last?.kills).toBe(0);
  });

  it('pauses at once a session already at a boundary, and shows every client', async () => {
    held().disk[RECORD] = record('awaiting-input');
    const client = await running();
    const watching = await attach();

    await client.say({ type: 'session-pause', id: 3, storeId: WORK, sessionId: SESSION });

    expect(client.reply(3)).toMatchObject({ type: 'session-paused', pause: 'paused' });
    // The other client asked nothing and was answered nothing; it learns from
    // the holder on the machine state, which is the one place any client reads
    // a pause from.
    held().timers.fireAll();
    await until(() => watching.holder()?.pause === 'paused', 'the watcher to see the pause');
    expect(watching.heard().some((frame) => frame.type === 'session-paused')).toBe(false);
  });

  it('resumes a paused session, with the holder back to none', async () => {
    held().disk[RECORD] = record('awaiting-input');
    const client = await running();
    await client.say({ type: 'session-pause', id: 3, storeId: WORK, sessionId: SESSION });
    expect(client.holder()?.pause).toBe('paused');

    await client.say({ type: 'session-resume', id: 4, storeId: WORK, sessionId: SESSION });

    expect(client.reply(4)).toEqual({
      type: 'session-resumed',
      replyTo: 4,
      storeId: WORK,
      sessionId: SESSION,
      server: MACHINE,
    });
    expect(client.holder()).toEqual({ server: MACHINE, stoppable: true, pause: 'none' });
    expect(held().ptys.last?.kills).toBe(0);
  });

  it('refuses a pause and a resume for a session nothing is running, in words', async () => {
    const client = await attach();

    await client.say({ type: 'session-pause', id: 2, storeId: WORK, sessionId: SESSION });
    await client.say({ type: 'session-resume', id: 3, storeId: WORK, sessionId: SESSION });

    const refusal = {
      type: 'refusal',
      code: 'refused',
      message: 'nothing the hub can see is running that session',
      holder: null,
    };
    expect(client.reply(2)).toEqual({ ...refusal, replyTo: 2 });
    expect(client.reply(3)).toEqual({ ...refusal, replyTo: 3 });
  });

  it('refuses, rather than remembering a pause, when the machine has gone away', async () => {
    const client = await running();
    for (const socket of held().live) {
      socket.close({ code: 1006, reason: 'the machine went away' });
    }
    await until(
      () =>
        held()
          .state.snapshot()
          .stores.every((store) => !store.reachable),
      'the machine to go away',
    );

    await client.say({ type: 'session-pause', id: 3, storeId: WORK, sessionId: SESSION });

    // The reducer publishes no holder for a machine it cannot reach, so the
    // refusal is the one a stop gets in the same situation.
    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      replyTo: 3,
      code: 'refused',
      message: 'nothing the hub can see is running that session',
    });
    expect(held().terminals.holder({ storeId: WORK, sessionId: SESSION })?.pause).toBe('none');
  });

  it('carries no key that would make a pause an execution surface', async () => {
    const client = await running();
    await client.say({ type: 'session-pause', id: 3, storeId: WORK, sessionId: SESSION });
    await client.say({ type: 'session-resume', id: 4, storeId: WORK, sessionId: SESSION });

    const hubToServer = held().dialled.flatMap((pair) =>
      pair.hubEnd.sent.map((text) => parsedFrame<HubToServerFrame>(parseHubToServerFrame, text)),
    );
    const serverToHub = held().dialled.flatMap((pair) =>
      pair.serverEnd.sent.map((text) => parsedFrame<ServerToHubFrame>(parseServerToHubFrame, text)),
    );

    for (const type of ['session-pause', 'session-resume']) {
      expect(hubToServer.some((frame) => frame.type === type)).toBe(true);
    }
    for (const type of ['session-paused', 'session-resumed']) {
      expect(serverToHub.some((frame) => frame.type === type)).toBe(true);
      expect(client.heard().some((frame) => frame.type === type)).toBe(true);
    }
    for (const frame of [...client.said(), ...client.heard(), ...hubToServer, ...serverToHub]) {
      expect(forbiddenKeysIn(frame), `${frame.type} carried a forbidden key`).toEqual([]);
    }
  });
});
