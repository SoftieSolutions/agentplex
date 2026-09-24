import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type ServerRegistrationId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createSocketPair,
  createFakeTimers,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { serveServerEnd } from './server-end.js';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProviderAdapter,
  readyProvider,
  createFakeProviderFiles,
  createFakeStoreFiles,
} from '@agentplex/providers/testing';
import { createProviderRegistry } from '@agentplex/providers';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
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
import { createSessions } from '../../../apps/hub/src/features/sessions/sessions.js';
import { createTerminal, type Terminal } from '../../../apps/hub/src/features/terminal/terminal.js';
import { readTerminalTool } from '../../../apps/hub/src/features/mcp/read-terminal.js';
import { callTool, type ToolCall } from '../../../apps/hub/src/features/mcp/test-tool-call.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeProjects } from '../../../apps/hub/src/features/projects/fake-projects.js';
import { createFakeCatalogue } from '../../../apps/hub/src/features/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/features/docs/fake-docs.js';
import { createFakeGraphs } from '../../../apps/hub/src/features/graphs/fake-graphs.js';
import { createFakeGraphRuns } from '../../../apps/hub/src/features/graph-runs/fake-graph-runs.js';

/**
 * `read_terminal`, from a pty on one machine to an agent reading it as text.
 *
 * `read-terminal.test.ts` in the hub covers what the tool decides for itself
 * against a stand-in relay. This is the question no stand-in can answer: that
 * the thing the tool subscribes to is the real relay, that the replay it counts
 * is the real server's real scrollback, and that the bytes a fake pty printed
 * come back as the characters it printed them as -- across two parsers, a
 * base64 encode, a socket, a fan-out and a decode.
 *
 * It is also where the whole-chunk trim is worth asserting, because here the
 * chunks are real: one `emit` on the pty is one chunk in the server's
 * scrollback, one `terminal-output` frame on each leg, and one boundary the
 * trim is allowed to cut on.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const ATTIC = 'registration-attic' as ServerRegistrationId;

/**
 * Output a decoder would ruin, and the reason this tool is the one place that
 * decodes: box drawing, an emoji past the basic plane, and a trailing byte that
 * is half a code point -- which is what a chunk boundary looks like from
 * outside.
 */
const DRAWN = new Uint8Array([...new TextEncoder().encode('[1m┌──┐ \u{1f642}[0m\r\n'), 0xf0, 0x9f]);

interface Harness {
  readonly state: FleetState;
  readonly terminal: Terminal;
  readonly clients: Clients;
  readonly connections: Servers;
  readonly ptys: FakePtyFactory;
  readonly terminals: TerminalManager;
  readonly timers: FakeTimers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

function storeOn(path: string): StoreDescriptor {
  return { storeId: WORK, path };
}

/** The one transcript the machine can see, so the scan reports one session. */
const sessionFiles: Record<string, string> = {
  '/volumes/work/claude/sessions/session-quiet.json': JSON.stringify({
    signal: 'awaiting-input',
    updatedAt: START - 5_000,
    cwd: '/volumes/work',
  }),
};

async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`mcp-read-terminal-${suite}`);
  const database = migrated.database;

  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `attic-run-${String(ptys.ptys.length)}` },
    environment: { PATH: '/usr/bin' },
  });
  const terminals = createTerminalManager({ supervisor, clock });

  await registerServer(
    database,
    { newId: () => ATTIC },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );

  const dialer: SocketDialer = {
    dial: async (): Promise<DialResult> => {
      const stores = [storeOn('/volumes/work')];
      const { hubEnd, serverEnd } = createSocketPair();
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores,
        providers: [readyProvider('claude')],
        terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions: createSessionController({
          stores,
          providers: createProviderRegistry([
            createFakeProviderAdapter({
              provider: 'claude',
              files: createFakeProviderFiles({ files: sessionFiles }),
            }),
          ]),
          terminals,
          workingTree: createFakeWorkingTree(),
          // No roots, which is the default a server ships with: nothing in
          // this file starts in a project, so no instruction carries a
          // directory to be bounded against.
          browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
          // No hook socket in these suites: what a launch is handed before
          // it starts has its own tests on the server side.
          approvals: null,
          clock,
          logger,
        }),
        logger,
      });
      return { ok: true, socket: hubEnd };
    },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });

  // The same composition `hub.ts` uses, knot and all: the relay puts frames to
  // the servers and the servers hand it what arrives.
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
      terminal.noteStarts(report.registrationId, report.storeId, report.starts);
    },
    onStream: (registrationId, output) => terminal.deliver(registrationId, output),
  });

  const terminal = createTerminal({ state, servers: connections, logger });

  let minted = 0;
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
      // A fake project table: every start here names a store and a machine,
      // and the rows are the project suites' subject rather than this one's.
      projects: createFakeProjects(),
      connections,
      ids: { newId: () => `start-${String((minted += 1))}` },
      logger,
      // Reading a terminal is this suite's subject; what a start was for is
      // the tasks feature's own.
      onStarted: async () => undefined,
    }),
    // The seams `hub.ts` hands the broadcast alongside the relay. None of them
    // is this file's subject, but a broadcast built without them would be a
    // different broadcast.
    // Not this suite's subject; the fake keeps the rows in memory and answers
    // the two frames the way the real feature does.
    attention: createFakeAttention(),
    // Nothing in this file answers an approval; a broadcast built without the
    // seam would be a different broadcast from the one the hub runs.
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    pairing,
    syncServers: () => connections.sync(),
    projects: createFakeProjects(),
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    graphs: createFakeGraphs(),
    graphRuns: createFakeGraphRuns(),
    terminal,
    // No push: none of these suites is about it, and a broadcast whose push
    // seam is absent is not the broadcast the hub builds.
    push: null,
  });

  await connections.sync();

  return { state, terminal, clients, connections, ptys, terminals, timers };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Turns of the loop: an answer that crosses to the machine and back. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A client, only to start the session.
 *
 * The agent reading the terminal is not this client and holds no socket -- that
 * is the whole of what the MCP endpoint offers over the client protocol -- but
 * something has to have forked a pty for there to be a terminal at all.
 */
async function startTheSession(): Promise<FakeMessageSocket> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const say = async (frame: ClientFrame): Promise<void> => {
    socket.receive(JSON.stringify(frame));
    await settle();
  };

  await say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  await say({
    type: 'session-start',
    id: 2,
    storeId: WORK,
    sessionId: QUIET,
    provider: 'claude',
    prompt: null,
    server: ATTIC,
    project: null,
  });

  const answered = socket.sent
    .map((text) => parseTextFrame(parseHubFrame, text))
    .filter((parsed) => parsed.ok)
    .map((parsed) => parsed.value as HubFrame);
  expect(answered.some((frame) => frame.type === 'session-started')).toBe(true);
  return socket;
}

function reading(args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(readTerminalTool({ terminal: held().terminal, timers: held().timers }), {
    storeId: WORK,
    sessionId: QUIET,
    ...args,
  });
}

interface Transcript {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

describe('an agent reading a terminal through MCP', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'attic to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) > 0,
      'the store to be reported',
    );
    await startTheSession();
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('returns what the pty printed, as the characters it printed', async () => {
    held().ptys.last?.emit('building\r\n');
    held().ptys.last?.emit('still building\r\n');
    held().ptys.last?.emit('done\r\n');
    await settle();

    const result = await reading();

    const answered = result.structured as unknown as Transcript;
    expect(answered.text).toBe('building\r\nstill building\r\ndone\r\n');
    expect(answered.bytes).toBe(32);
    expect(answered.truncated).toBe(false);
    // Nothing was evicted, so this is the session from its first byte -- the
    // fact `droppedBytes` exists to state.
    expect(answered.droppedBytes).toBe(0);
    // The text block is the transcript itself, not JSON of it.
    expect(result.text).toBe('building\r\nstill building\r\ndone\r\n');
  });

  it('cuts on the boundaries the chunks actually have', async () => {
    // Three chunks of ten bytes, because one emit is one chunk in the server's
    // scrollback and one frame on each leg. Twenty-five bytes fits two of them,
    // and the third cannot be half-taken.
    held().ptys.last?.emit('0123456789');
    held().ptys.last?.emit('abcdefghij');
    held().ptys.last?.emit('klmnopqrst');
    await settle();

    const answered = (await reading({ maxBytes: 25 })).structured as unknown as Transcript;

    expect(answered.text).toBe('abcdefghijklmnopqrst');
    expect(answered.bytes).toBe(20);
    expect(answered.truncated).toBe(true);
  });

  it('decodes bytes nothing else on this path would touch', async () => {
    held().ptys.last?.emit(DRAWN);
    await settle();

    const answered = (await reading()).structured as unknown as Transcript;

    // The escape sequences and the emoji survive the round trip; the half code
    // point the pty ended on becomes a replacement character, because an agent
    // reading text is the consumer these bytes were produced for and there is
    // no emulator downstream to hand them to.
    expect(answered.text).toContain('[1m┌──┐ \u{1f642}[0m');
    expect(answered.text.endsWith('�')).toBe(true);
    expect(answered.bytes).toBe(DRAWN.length);
  });

  it('leaves the terminal alone: the agent detaches and the session runs on', async () => {
    held().ptys.last?.emit('working\r\n');
    await settle();

    await reading();
    await reading();
    await settle();

    // Two reads, two subscriptions, both given back. The server is left with
    // the terminal it had and the agent it was running: reading is not
    // attaching, and detaching closes nothing.
    expect(held().terminals.terminals).toHaveLength(1);
    expect(held().ptys.last?.kills).toBe(0);
    // And a third read still works, which is what proves the second detach was
    // a detach and not a leak of a watch under a client that is gone.
    const answered = (await reading()).structured as unknown as Transcript;
    expect(answered.text).toBe('working\r\n');
  });

  it('refuses a session the fleet does not have, naming what it looked for', async () => {
    const result = await reading({ sessionId: 'session-nowhere' });

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The relay's own sentence, not this tool's. A blank pane and a machine
    // that is asleep draw the same rectangle; the words are the difference.
    expect(result.text.length).toBeGreaterThan(10);
  });
});
