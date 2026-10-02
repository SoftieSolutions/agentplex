import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  serverIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type MachineState,
  type ServerRegistrationId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createFakeTimers,
  createSocketPair,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProcessProbe,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readProviderFixture,
  readyProvider,
} from '@agentplex/providers/testing';
import {
  createClaudeAdapter,
  createProviderRegistry,
  type ProviderFiles,
} from '@agentplex/providers';
import { serveServerEnd } from './server-end.js';
import { createFakeWorkingTree } from '../../../apps/server/src/working-tree/fake-working-tree.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directories/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/directories/fake-directory-reader.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createHubAudience } from '../../../apps/server/src/hub/hub-audience.js';
import { createSessionController } from '../../../apps/server/src/sessions/session-control.js';
import {
  createFakeStoreWatcher,
  type FakeStoreWatcher,
} from '../../../apps/server/src/store-watch/fake-store-watcher.js';
import {
  STORE_WATCH_DEBOUNCE_MS,
  watchStores,
  type StoreWatchers,
} from '../../../apps/server/src/store-watch/store-watch.js';
import { createTerminalManager } from '../../../apps/server/src/terminal/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/attention/fake-attention.js';
import { createFakeCatalogue } from '../../../apps/hub/src/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/docs/fake-docs.js';
import { createFakeGraphs } from '../../../apps/hub/src/graphs/fake-graphs.js';
import { createFakeGraphRuns } from '../../../apps/hub/src/graph-runs/fake-graph-runs.js';
import { createFakeTerminal } from '../../../apps/hub/src/terminal/fake-terminal.js';
import { createExponentialBackoff } from '../../../apps/hub/src/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/fleet-state/fleet-state.js';
import { createProjects } from '../../../apps/hub/src/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/sessions/sessions.js';
import { createFakeProcessSignaller } from '../../../apps/server/src/sessions/fake-process-signaller.js';

/**
 * A claude a client started with no prompt, named by its session registry
 * before it has written a single turn.
 *
 * Claude Code registers `<store>/sessions/<pid>.json`, session id included,
 * within seconds of starting, and writes no transcript until somebody types
 * (2.1.287, run at the origin for AGX-373). A spawn with no prompt is exactly
 * the session nobody has typed into yet, so until the registry was read the hub
 * listed nothing for it and held nothing: the client that started it had no row
 * to open.
 *
 * Everything but the socket, the pty, the process table and the disk is the
 * shipped code: the real Claude Code adapter over the captured registry entry,
 * the real session controller and terminal manager, the real store watch, a
 * real handshake, both parsers and the real reducer. The pid the entry names is
 * the pid the fake pty handed out, because a launch execs claude with no shell
 * in between and the registry pid is claude's own.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const HOME = '/home/agentplex';
const STORE: StoreDescriptor = {
  storeId: storeIdSchema.parse('store-home'),
  path: `${HOME}/.claude`,
};
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;

/** The pid the fake pty hands the spawn, and the process the probe vouches for. */
const PID = 4242;
/** The id the forked claude registers. */
const SESSION = '5df6a5a1-1c69-4713-9c09-e05a0dbbee62';

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  /** The store as the server reads it, written to mid-run as a provider would. */
  readonly disk: Record<string, string>;
  readonly ptys: FakePtyFactory;
  readonly watcher: FakeStoreWatcher;
  /** The server's own timers, which the store watch's debounce runs on. */
  readonly serverTimers: FakeTimers;
  /** The broadcast's, which a machine state is coalesced on before it goes out. */
  readonly clientTimers: FakeTimers;
  readonly watches: StoreWatchers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** One hub, one paired machine running the real claude adapter over an empty store. */
async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`spawn-named-by-registry-${suite}`);
  const database = migrated.database;

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

  // Re-read on every call, so a file the provider writes after the spawn is
  // there at the next scan, as it would be on a disk.
  const disk: Record<string, string> = {};
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: disk }).readFile(path),
    listDirectory: (path) => createFakeProviderFiles({ files: disk }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: disk }).readFileTail(path, maxBytes),
    stat: (path) => createFakeProviderFiles({ files: disk }).stat(path),
  };
  const adapter = createClaudeAdapter({
    files,
    // Fixed at construction, as the fake probe's table is: the process is
    // registered up front and only becomes visible once its entry is written.
    probe: createFakeProcessProbe({ processes: { [PID]: START } }),
    // The controller's home, so the two answer for one account.
    homeDirectory: HOME,
  });

  // The machine's durable half, kept across dials as a server keeps it.
  const ptys = createFakePtyFactory({ pids: [PID] });
  const terminals = createTerminalManager({
    supervisor: createPtySupervisor({
      pty: ptys,
      clock,
      ids: { newId: () => `run-${String(ptys.ptys.length)}` },
      environment: {},
    }),
    clock,
    timers: createFakeTimers(),
  });
  const sessions = createSessionController({
    signaller: createFakeProcessSignaller(),
    timers: createFakeTimers(),
    stores: [STORE],
    providers: createProviderRegistry([adapter]),
    terminals,
    workingTree: createFakeWorkingTree(),
    // No directory on the start, so the spawn runs here, which the store is
    // under and is not.
    homeDirectory: HOME,
    browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
    approvals: null,
    clock,
    logger,
  });
  // One audience for the connection and the watch, as `server.ts` composes
  // it: a change the watch notices is reported through the same call a start
  // makes.
  const audience = createHubAudience({ sessions, logger });
  const watcher = createFakeStoreWatcher();
  const serverTimers = createFakeTimers();
  const watches = watchStores({
    stores: [STORE],
    watcher,
    audience,
    timers: serverTimers,
    logger,
  });

  const dialer: SocketDialer = {
    dial: async (): Promise<DialResult> => {
      const { hubEnd, serverEnd } = createSocketPair();
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores: [STORE],
        providers: [readyProvider('claude')],
        terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions,
        audience,
        logger,
      });
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

  let minted = 0;
  const ids = { newId: () => `id-${String((minted += 1))}` };
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    onTreeChanged: () => undefined,
  });

  // Apart from the connection's timers, so flushing a broadcast fires no
  // heartbeat and no redial.
  const clientTimers = createFakeTimers();
  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers: clientTimers,
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
    // Not this suite's subject: a start and the row it comes back as are.
    attention: createFakeAttention(),
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    push: null,
    pairing,
    syncServers: () => connections.sync(),
    projects,
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    graphs: createFakeGraphs(),
    graphRuns: createFakeGraphRuns(),
    terminal: createFakeTerminal(),
  });

  await connections.sync();

  return {
    state,
    clients,
    connections,
    disk,
    ptys,
    watcher,
    serverTimers,
    clientTimers,
    watches,
  };
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
  /** The newest machine state the hub sent this client. */
  latest(): MachineState;
}

/** A client on a socket, read back through the parser a client would use. */
async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const heard = (): HubFrame[] =>
    socket.sent.map((text) => {
      const parsed = parseTextFrame(parseHubFrame, text);
      if (!parsed.ok) throw new Error(`the hub sent an unparseable frame: ${parsed.reason}`);
      return parsed.value;
    });

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      socket.receive(JSON.stringify(frame));
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      held().clientTimers.fireAll();
    },
    reply(id: number): HubFrame {
      const answer = heard().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
    latest(): MachineState {
      const states = heard().flatMap((frame) =>
        frame.type === 'machine-state' ? [frame.state] : [],
      );
      const last = states.at(-1);
      if (last === undefined) throw new Error('the hub sent this client no machine state');
      return last;
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  return client;
}

/** Every session row a machine state lists, as `[sessionId, holder]`. */
function rows(state: MachineState): [string, unknown][] {
  return state.stores
    .flatMap((store) => store.sessions)
    .map((row) => [row.descriptor.sessionId, row.holder]);
}

describe('a client start with no prompt', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'the server to be connected',
    );
    await until(() => held().state.snapshot().stores.length > 0, 'the machine to report its store');
  });

  afterEach(async () => {
    held().watches.stop();
    await held().connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('is listed held by its server once claude registers, before any transcript turn', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: STORE.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: MACHINE,
      project: null,
    });

    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'session-started', server: MACHINE, sessionId: null });
    // No prompt, so nothing on argv: the claude that runs is waiting for a
    // person, which is the session this ticket is about.
    expect(held().ptys.opened.map((request) => request.args)).toEqual([[]]);
    // Nothing registered yet, so nothing to list.
    expect(rows(client.latest())).toEqual([]);

    // What the forked claude writes a beat after it starts: the captured
    // entry, with only the pid, the id, the cwd and the dates bent to this
    // spawn.
    held().disk[`${STORE.path}/sessions/${String(PID)}.json`] = JSON.stringify({
      ...JSON.parse(await readProviderFixture('claude-session-registry.json')),
      pid: PID,
      sessionId: SESSION,
      cwd: HOME,
      startedAt: START + 1_302,
      status: 'idle',
      statusUpdatedAt: START + 1_302,
    });
    // One report cycle: the store watch sees the write and reports once its
    // window closes.
    held().watcher.change(STORE.path);
    expect(held().serverTimers.delays).toContain(STORE_WATCH_DEBOUNCE_MS);
    held().serverTimers.fireAll();
    await until(
      () =>
        held()
          .state.snapshot()
          .stores.some((store) => store.sessions.length > 0),
      'the server to report the registered session',
    );
    held().clientTimers.fireAll();

    expect(rows(client.latest())).toEqual([
      [SESSION, { server: MACHINE, stoppable: true, pause: 'none' }],
    ]);
    // And still no transcript anywhere in the store: the registry alone named it.
    expect(Object.keys(held().disk).filter((path) => path.includes('/projects/'))).toEqual([]);
  });
});
