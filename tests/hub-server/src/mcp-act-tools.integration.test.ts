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
import { listSessionsTool } from '../../../apps/hub/src/features/mcp/list-sessions.js';
import { sendInputTool } from '../../../apps/hub/src/features/mcp/send-input.js';
import { startSessionTool } from '../../../apps/hub/src/features/mcp/start-session.js';
import { stopSessionTool } from '../../../apps/hub/src/features/mcp/stop-session.js';
import { callTool, type ToolCall } from '../../../apps/hub/src/features/mcp/test-tool-call.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeProjects } from '../../../apps/hub/src/features/projects/fake-projects.js';

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

interface Harness {
  readonly state: FleetState;
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
          // No roots, which is the default a server ships with: `start_session`
          // names no project, so no instruction carries a directory to be
          // bounded against.
          browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
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
  const sessions = createSessions({
    state,
    // A fake project table, and empty. The tool passes `project: null`, so
    // nothing here ever asks it for a directory -- it is the seam the feature
    // takes rather than a subject of this file.
    projects: createFakeProjects(),
    connections,
    ids: { newId: () => 'start-1' },
    logger,
  });

  await connections.sync();

  return { state, terminal, sessions, connections, ptys, terminals, timers };
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
