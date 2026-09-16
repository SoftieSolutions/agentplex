import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createSocketPair,
  createFakeTimers,
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
import { createSessions, type Sessions } from '../../../apps/hub/src/features/sessions/sessions.js';
import { createTerminal, type Terminal } from '../../../apps/hub/src/features/terminal/terminal.js';
import { listProjectsTool } from '../../../apps/hub/src/features/mcp/list-projects.js';
import { listSessionsTool } from '../../../apps/hub/src/features/mcp/list-sessions.js';
import { sendInputTool } from '../../../apps/hub/src/features/mcp/send-input.js';
import { startSessionTool } from '../../../apps/hub/src/features/mcp/start-session.js';
import { stopSessionTool } from '../../../apps/hub/src/features/mcp/stop-session.js';
import { callTool, type ToolCall } from '../../../apps/hub/src/features/mcp/test-tool-call.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createProjects, type Projects } from '../../../apps/hub/src/features/projects/projects.js';

/**
 * The act tools, from an agent's call to a pty on another machine and back.
 *
 * The unit suites in `features/mcp` cover what each tool decides against a fake
 * of the feature it calls. This is the question no fake can answer: that the
 * feature behind each tool is the real one, that a start the hub scheduled
 * reaches a machine and forks a process, that the characters an agent typed are
 * the bytes the pty was written, and that a stop resolved hub-side ends the
 * thing that was running.
 *
 * A start in a project is the case that needs all three parties at once, so
 * the projects feature here is the real one over a real schema and the machine
 * has real browse roots. The agent names a node; the hub reads the directory
 * out of its own rows; the machine checks the real path against a root its own
 * operator configured; and the pty is forked there or the refusal is that
 * machine's own sentence. No string on any tool call in this file is that
 * path.
 *
 * There is no client socket anywhere in this file, and that is the point of the
 * endpoint rather than a shortcut in the harness: the agent driving this hub
 * holds nothing open, attaches to nothing, and is answered out of the same
 * features a browser's frames reach.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const FRESH = sessionIdSchema.parse('session-fresh');
const ATTIC = 'registration-attic' as ServerRegistrationId;

/**
 * The one directory this machine's operator said work may happen in, and two
 * checkouts: one under it and one that is not.
 *
 * Both exist on the fake disk, which is what makes the second case the one
 * worth having. A project outside every root is refused for being outside a
 * root -- the sentence somebody can act on by configuring one -- rather than
 * for not being there.
 */
const BROWSE_ROOT = '/volumes/work';
const PROJECT_DIRECTORY = '/volumes/work/agentplex';
const OUTSIDE = '/elsewhere/checkout';

interface Harness {
  readonly state: FleetState;
  readonly projects: Projects;
  readonly terminal: Terminal;
  readonly sessions: Sessions;
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

/**
 * What the machine can see on disk.
 *
 * Two transcripts, and the times are the subject of one of them. A spawn has no
 * session id until the provider writes one, and the server joins the terminal
 * it forked to the session that was written at or after the fork -- so
 * `session-fresh`, dated now, is the one a start binds to, and `session-quiet`,
 * dated five seconds ago, is a session on disk that nothing is running.
 *
 * `signal` on the fresh one is what makes it stoppable or not: a transcript
 * that says it is waiting on a person is a session it is safe to stop, and one
 * that says it is mid-turn is the refusal `stop_session` exists to make.
 */
function transcripts(signal: 'awaiting-input' | 'progressing'): Record<string, string> {
  const at = (said: string, updatedAt: number): string =>
    JSON.stringify({ signal: said, updatedAt, cwd: '/volumes/work' });

  return {
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input', START - 5_000),
    '/volumes/work/claude/sessions/session-fresh.json': at(signal, START),
  };
}

async function start(
  signal: 'awaiting-input' | 'progressing' = 'awaiting-input',
): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`mcp-act-tools-${suite}`);
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
              files: createFakeProviderFiles({ files: transcripts(signal) }),
            }),
          ]),
          terminals,
          workingTree: createFakeWorkingTree(),
          // The roots this machine's operator configured, and the rule a start
          // carrying a project's directory is checked against. A start that
          // names no project carries no directory and never reaches it.
          browse: createDirectoryBrowser({
            roots: [BROWSE_ROOT],
            reader: createFakeDirectoryReader({
              directories: { [BROWSE_ROOT]: [], [PROJECT_DIRECTORY]: [], [OUTSIDE]: [] },
            }),
          }),
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
  // The real rows, because a project is the one argument a start carries that
  // the hub turns into a value: a node id in, a directory out, read here and
  // nowhere else. A fake table would leave the turn untested at exactly the
  // point this file exists to test it.
  let nodes = 0;
  const projects = createProjects({
    database,
    ids: { newId: () => `node-${String((nodes += 1))}` },
    clock,
    state,
    connections,
    logger,
    onTreeChanged: () => undefined,
  });
  const sessions = createSessions({
    state,
    projects,
    connections,
    ids: { newId: () => 'start-1' },
    logger,
  });

  await connections.sync();

  return { state, projects, terminal, sessions, connections, ptys, terminals, timers };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function starting(args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(startSessionTool({ sessions: held().sessions }), {
    storeId: WORK,
    provider: 'claude',
    ...args,
  });
}

function typing(args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(sendInputTool({ terminal: held().terminal, logger }), {
    storeId: WORK,
    sessionId: FRESH,
    text: 'ship it',
    ...args,
  });
}

function stopping(args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(stopSessionTool({ sessions: held().sessions }), {
    storeId: WORK,
    sessionId: FRESH,
    ...args,
  });
}

function listing(): Promise<ToolCall> {
  return callTool(listSessionsTool({ state: held().state }), {});
}

function listingProjects(): Promise<ToolCall> {
  return callTool(listProjectsTool({ projects: held().projects }), {});
}

/** A project in this hub's rows, as a person makes one after browsing. */
async function project(name: string, directory: string): Promise<string> {
  const made = await held().projects.create({ name, directory });
  if (!made.ok) throw new Error(`the project was not made: ${made.problem}`);
  return made.nodeId;
}

interface SessionRowView {
  readonly sessionId: string;
  readonly status: string;
  readonly holder: { readonly server: string; readonly stoppable: boolean } | null;
}

async function connected(): Promise<void> {
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
}

afterEach(async () => {
  await harness?.connections.stop();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('an agent starting, steering and stopping a session through MCP', () => {
  beforeEach(async () => {
    harness = await start();
    await connected();
  });

  it('starts a session the hub scheduled, and the machine forks the agent', async () => {
    const result = await starting({ prompt: 'read the ticket' });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({
      storeId: WORK,
      // The provider has not written an id yet: this is a spawn, and the start
      // id is the only name it has until a scan finds one.
      sessionId: null,
      server: ATTIC,
      startId: 'start-1',
    });
    // The prompt reached the child as one argument of an argv the adapter
    // built, with no shell anywhere on the path. There is no other string from
    // this call anywhere in the request.
    expect(held().ptys.opened).toHaveLength(1);
    expect(held().ptys.opened[0]).toMatchObject({
      command: 'claude',
      args: ['read the ticket'],
      cwd: '/volumes/work',
    });
  });

  it('names the session it started, once the machine has scanned for it', async () => {
    await starting();

    const listed = (await listing()).structured?.['sessions'] as unknown as SessionRowView[];

    // The store report goes out before the answer to the start, so by the time
    // an agent has been told the start succeeded the session is in the state it
    // can list -- and the machine holding it is named on the row.
    const fresh = listed.find((row) => row.sessionId === FRESH);
    expect(fresh?.holder).toEqual({ server: ATTIC, stoppable: true });
  });

  it('types what an agent typed, as the bytes the pty is written', async () => {
    await starting();

    const result = await typing();

    expect(result.structured).toEqual({
      storeId: WORK,
      sessionId: FRESH,
      characters: 8,
      chunks: 1,
    });
    // The whole path: a tool call, the relay, a socket, the server's terminal
    // manager and the pty. A prompt is typed input, so what arrives is the
    // words and the return, and nothing else.
    expect(held().ptys.last?.written).toEqual(['ship it\r']);
  });

  it('stops the holder the hub resolved, and the process is killed', async () => {
    await starting();
    expect(held().ptys.last?.kills).toBe(0);

    const result = await stopping();

    expect(result.structured).toEqual({ storeId: WORK, sessionId: FRESH, server: ATTIC });
    // The agent named a session and never a machine; the hub worked out which
    // one held it, and the machine ended its own process.
    expect(held().ptys.last?.kills).toBe(1);
  });

  it('refuses a stop for a session that is only a transcript', async () => {
    const result = await stopping({ sessionId: QUIET });

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    expect(result.text).toBe('nothing the hub can see is running that session');
    expect(held().ptys.ptys).toHaveLength(0);
  });
});

describe('an agent starting a session in a project', () => {
  beforeEach(async () => {
    harness = await start();
    await connected();
  });

  it('spawns in the project directory, which no call in this file said', async () => {
    const projectId = await project('agentplex', PROJECT_DIRECTORY);

    const result = await starting({ projectId, prompt: 'read the ticket' });

    expect(result.isError).toBe(false);
    // The whole point of the argument being a node id. The agent said
    // `projectId`; the hub read the directory out of its own rows; the machine
    // checked that real path against the root its own operator configured; and
    // the pty was forked there. No string on the tool call is this path.
    expect(held().ptys.opened[0]).toMatchObject({
      command: 'claude',
      args: ['read the ticket'],
      cwd: PROJECT_DIRECTORY,
    });
  });

  it('leaves a start that names no project in the store own folder', async () => {
    await starting();

    // The behaviour this tool shipped with, unchanged by the argument being
    // there: an absent project is the store's directory and the machine is
    // asked to check nothing.
    expect(held().ptys.opened[0]).toMatchObject({ cwd: '/volumes/work' });
  });

  it('is refused in the machine own words when no root covers the project', async () => {
    const projectId = await project('elsewhere', OUTSIDE);

    const result = await starting({ projectId });

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The refusal comes from the box that would have spawned, because the
    // roots are its operator's and nobody else can answer. The hub made the
    // project happily -- it holds no server's root list -- so the first start
    // is where this is found out, which is the cost migration 0006 wrote down.
    expect(result.text).toBe(`${OUTSIDE} is not under a directory this server will browse`);
    expect(held().ptys.ptys).toHaveLength(0);
  });

  it('is refused by the hub for a project it has no row for, before any machine is asked', async () => {
    const result = await starting({ projectId: 'node-nowhere' });

    expect(result.isError).toBe(true);
    // Not a placement problem, so it is not answered like one: there is no
    // machine that would make it right, and nothing was asked of one.
    expect(result.text).toBe('this hub has no project by that id');
    expect(held().ptys.ptys).toHaveLength(0);
  });

  it('lists the project an agent would name, with the id the start takes', async () => {
    const projectId = await project('agentplex', PROJECT_DIRECTORY);

    const listed = (await listingProjects()).structured?.['projects'];

    // The two halves of one capability: this is where the id in the call above
    // comes from, and the directory beside it is what tells a person which
    // checkout they are about to run in.
    expect(listed).toEqual([{ projectId, name: 'agentplex', directory: PROJECT_DIRECTORY }]);
  });
});

describe('an agent asking to stop a session that is mid-turn', () => {
  beforeEach(async () => {
    harness = await start('progressing');
    await connected();
  });

  it('is refused, and told which machine is holding it', async () => {
    await starting();

    const result = await stopping();

    expect(result.isError).toBe(true);
    // The refusal the busy holder gets, end to end: the machine reported the
    // session as not stoppable, the hub refused before instructing anything,
    // and the agent is told the sentence and the id of the machine to look at.
    expect(result.text).toBe(
      `that session is mid-turn; stopping it now could leave an edit half applied; it is held by ${ATTIC}`,
    );
    expect(held().ptys.last?.kills).toBe(0);
  });

  it('still takes input, because typing at a busy terminal is what a person does', async () => {
    await starting();

    const result = await typing({ text: 'stop after this file', newline: false });

    expect(result.isError).toBe(false);
    // Steering is not stopping. A session mid-turn may not be killed and may
    // always be talked to, which is the same rule the screen follows: the stop
    // button is withheld and the steer bar is not.
    expect(held().ptys.last?.written).toEqual(['stop after this file']);
  });
});
