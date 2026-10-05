import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type SessionRef,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import {
  createFakeProcessProbe,
  createFakeProviderFiles,
  readProviderFixture,
} from '@agentplex/providers/testing';
import {
  createClaudeAdapter,
  createCodexAdapter,
  createProviderRegistry,
  type Launch,
  type ProviderFiles,
} from '@agentplex/providers';
import { createDirectoryBrowser } from '../directories/directory-browse.js';
import { createFakeDirectoryReader } from '../directories/fake-directory-reader.js';
import { createHubAudience } from '../hub/hub-audience.js';
import { createFakeTerminals } from '../terminal/fake-terminals.js';
import type { TerminalManager } from '../terminal/terminal-manager.js';
import type { FakePtyFactory } from '@agentplex/pty/testing';
import { createFakeWorkingTree } from '../working-tree/fake-working-tree.js';
import { createFakeProcessSignaller, type FakeProcessSignaller } from './fake-process-signaller.js';
import { createIdleStop, IDLE_STOP_SWEEP_MS, type IdleStop } from './idle-stop.js';
import { createSessionController, type SessionController } from './session-control.js';

/**
 * The idle stop, against the real Claude adapter reading a registry entry
 * captured from Claude Code, with only the pid, the dates and the status bent.
 *
 * The status is what every case here turns on, and it is Claude Code's own
 * word for what its process is doing; a fake adapter would only hand back
 * whichever phase the test told it to. The stop is the session controller's,
 * the same one a person's stop goes through, so what ends the process is what
 * would end it if somebody pressed the button.
 *
 * Time is the test's: one clock for the terminals and the sweep, and the sweep
 * fires only when a case says. Each case names the minute it sweeps at.
 */

const START = 1_756_000_000_000;
const MINUTE = 60_000;
const IDLE_STOP_MS = 15 * MINUTE;

const WORK = storeIdSchema.parse('store-work');
const STORE: StoreDescriptor = { storeId: WORK, path: '/volumes/work' };

const SESSION = sessionIdSchema.parse('10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde');
const HELD: SessionRef = { storeId: WORK, sessionId: SESSION };

/** The pid the first fake pty reports, which is the claude this server holds. */
const HELD_PID = 1_000;
const REGISTERED_AT = START - 600_000;
/** As far before its entry as the captured process started before its own. */
const PROCESS_STARTED_AT = REGISTERED_AT - 1_669;

const OUTSIDE_PID = 5_150;
const OUTSIDE = sessionIdSchema.parse('2b7f3a1e-9c4d-4e8a-b5f6-0d1c2e3f4a5b');

const CODEX_HELD: SessionRef = {
  storeId: WORK,
  sessionId: sessionIdSchema.parse('019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'),
};

const entryPath = (pid: number): string => `${STORE.path}/sessions/${pid}.json`;

const launch: Launch = {
  ok: true,
  plan: {
    command: 'claude',
    args: ['--resume', SESSION],
    cwd: '/Users/dev/Code/agentplex',
    env: {},
    scrubEnvPrefixes: ['CLAUDE'],
  },
};

const codexLaunch: Launch = {
  ok: true,
  plan: {
    command: 'codex',
    args: ['resume', CODEX_HELD.sessionId],
    cwd: '/Users/dev/Code/agentplex',
    env: {},
    scrubEnvPrefixes: ['CODEX'],
  },
};

/** A clock both the terminals and the sweep read, set by the case. */
interface TestClock {
  now(): number;
  at(minutes: number): void;
}

function testClock(): TestClock {
  let now = START;
  return {
    now: () => now,
    at(minutes: number) {
      now = START + minutes * MINUTE;
    },
  };
}

interface World {
  readonly clock: TestClock;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  readonly sessions: SessionController;
  readonly idle: IdleStop;
  /** The sweep's own timers, apart from the kill grace the terminals schedule. */
  readonly timers: FakeTimers;
  readonly signaller: FakeProcessSignaller;
  readonly records: readonly LogRecord[];
  /** Every store a stop asked to be reported, in order. */
  readonly reported: readonly StoreId[];
  /** Claude Code rewriting a registry entry's status, as it does on every change. */
  setStatus(pid: number, status: string): void;
  /** The sweep at this minute, run to its end. */
  sweepAt(minutes: number): Promise<void>;
  /** The signals the held claude's terminal has been sent. */
  held(): readonly string[];
  /** Makes the registry unreadable, so the adapter throws, or readable again. */
  breakRegistry(broken: boolean): void;
}

interface WorldOptions {
  /** The status in the held claude's registry entry. Absent, no entry at all. */
  readonly status?: string;
  /** Hold a session nobody registers, as a held codex is: codex keeps no registry. */
  readonly codex?: boolean;
  /** A claude outside agentplex, registered with this status, with no terminal here. */
  readonly outside?: string;
  /**
   * A claude outside agentplex resumed on the held session itself, registered
   * with this status and written after the held one, so the registry's newest.
   */
  readonly rival?: string;
  /** Report through a real hub audience with nobody in it, in place of a recorder. */
  readonly audience?: boolean;
}

async function world(options: WorldOptions = {}): Promise<World> {
  const fixture = JSON.parse(await readProviderFixture('claude-session-registry.json')) as Record<
    string,
    unknown
  >;
  const entry = (
    pid: number,
    sessionId: string,
    status: string,
    statusUpdatedAt = REGISTERED_AT,
  ): string =>
    JSON.stringify({
      ...fixture,
      pid,
      sessionId,
      startedAt: REGISTERED_AT,
      statusUpdatedAt,
      status,
    });

  const disk: Record<string, string> = {};
  if (options.status !== undefined)
    disk[entryPath(HELD_PID)] = entry(HELD_PID, SESSION, options.status);
  if (options.outside !== undefined) {
    disk[entryPath(OUTSIDE_PID)] = entry(OUTSIDE_PID, OUTSIDE, options.outside);
  }
  if (options.rival !== undefined) {
    disk[entryPath(OUTSIDE_PID)] = entry(OUTSIDE_PID, SESSION, options.rival, START);
  }
  // A fresh fake over the record on every read, so a rewrite shows up at the
  // next sweep the way Claude Code's own write would.
  let broken = false;
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: disk }).readFile(path),
    listDirectory: (path) => {
      if (broken) throw new Error('the volume went away');
      return createFakeProviderFiles({ files: disk }).listDirectory(path);
    },
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: disk }).readFileTail(path, maxBytes),
    stat: (path) => createFakeProviderFiles({ files: disk }).stat(path),
  };
  const probe = createFakeProcessProbe({
    processes: { [HELD_PID]: PROCESS_STARTED_AT, [OUTSIDE_PID]: PROCESS_STARTED_AT },
  });
  const providers = createProviderRegistry([
    createClaudeAdapter({ files, probe, homeDirectory: '/home/agentplex' }),
    createCodexAdapter({ files }),
  ]);

  const clock = testClock();
  const { terminals, factory } = createFakeTerminals({ clock });
  const opened =
    options.codex === true
      ? terminals.resume(CODEX_HELD, codexLaunch)
      : terminals.resume(HELD, launch);
  if (!opened.ok) throw new Error(`the held session should have opened: ${opened.problem}`);

  const records: LogRecord[] = [];
  const logger = createLogger('debug', (record) => records.push(record));
  const signaller = createFakeProcessSignaller({});
  const sessions = createSessionController({
    stores: [STORE],
    providers,
    terminals,
    workingTree: createFakeWorkingTree(),
    homeDirectory: '/home/agentplex',
    browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader({}) }),
    approvals: null,
    signaller,
    processes: probe,
    timers: createFakeTimers(),
    clock,
    logger,
  });

  const reported: StoreId[] = [];
  const timers = createFakeTimers();
  const idle = createIdleStop({
    terminals,
    providers,
    stores: [STORE],
    stop: (session) => sessions.stop(session),
    report:
      options.audience === true
        ? (storeId) => createHubAudience({ sessions, logger }).reportToAll(storeId)
        : async (storeId) => {
            reported.push(storeId);
          },
    clock,
    timers,
    logger,
    idleStopMs: IDLE_STOP_MS,
  });
  idle.start();

  return {
    clock,
    terminals,
    ptys: factory,
    sessions,
    idle,
    timers,
    signaller,
    records,
    reported,
    setStatus(pid: number, status: string) {
      const sessionId = pid === OUTSIDE_PID ? OUTSIDE : SESSION;
      disk[entryPath(pid)] = entry(pid, sessionId, status);
    },
    async sweepAt(minutes: number) {
      clock.at(minutes);
      expect(timers.delays).toEqual([IDLE_STOP_SWEEP_MS]);
      timers.fireAll();
      await settle();
    },
    held: () => factory.ptys[0]?.signals ?? [],
    breakRegistry(value: boolean) {
      broken = value;
    },
  };
}

/** Lets every promise that can move, move, as the event loop would between two timers. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const idleStops = (records: readonly LogRecord[]): readonly LogRecord[] =>
  records.filter((record) => record.message === 'idle session stopped');

describe('createIdleStop', () => {
  it('stops a held claude that has sat at its prompt for the whole setting, and not a minute before', async () => {
    const { sweepAt, held, records, reported } = await world({ status: 'idle' });

    await sweepAt(0);
    await sweepAt(14.99);
    expect(held()).toEqual([]);

    await sweepAt(15);
    // Through the session controller's stop, which is what logs this line and
    // what a person's stop goes through: a hangup, the kill grace behind it.
    expect(held()).toEqual(['SIGHUP']);
    expect(records.filter((record) => record.message === 'session stopped')).toHaveLength(1);
    const lines = idleStops(records);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: { storeId: WORK, sessionId: SESSION, idleMs: IDLE_STOP_MS },
    });
    // Told to every hub, the way a stop a hub asked for is.
    expect(reported).toEqual([WORK]);
  });

  it('stops it once, however many sweeps come after', async () => {
    const { sweepAt, held, records } = await world({ status: 'idle' });

    await sweepAt(0);
    await sweepAt(15);
    await sweepAt(16);
    await sweepAt(30);

    expect(held()).toEqual(['SIGHUP']);
    expect(idleStops(records)).toHaveLength(1);
  });

  it('starts the clock again every time a turn runs', async () => {
    const { sweepAt, setStatus, held } = await world({ status: 'idle' });

    await sweepAt(0);
    setStatus(HELD_PID, 'busy');
    await sweepAt(5);
    setStatus(HELD_PID, 'idle');
    await sweepAt(10);
    setStatus(HELD_PID, 'busy');
    await sweepAt(12);
    setStatus(HELD_PID, 'idle');
    await sweepAt(15);
    // Fifteen minutes after the first idle, and the first sweep of this one:
    // idle is dated from the sweep that saw it, so the clock starts here.
    expect(held()).toEqual([]);

    await sweepAt(29.99);
    expect(held()).toEqual([]);
    await sweepAt(30);
    expect(held()).toEqual(['SIGHUP']);
  });

  it.each(['busy', 'waiting', 'shell'])(
    'never stops a claude whose registry says %s, however long it says it',
    async (status) => {
      // `waiting` is a question somebody has not answered yet, and `shell` a
      // command they typed: both are a person in the middle of something.
      const { sweepAt, held, records } = await world({ status });

      for (const minute of [0, 15, 30, 60]) await sweepAt(minute);

      expect(held()).toEqual([]);
      expect(idleStops(records)).toEqual([]);
    },
  );

  it('never stops a claude it cannot find in the registry', async () => {
    // No entry is not idle. A status nobody can read is not leave to end a
    // process, and neither is a registry with nothing in it.
    const { sweepAt, held } = await world({});

    for (const minute of [0, 15, 30]) await sweepAt(minute);

    expect(held()).toEqual([]);
  });

  it('counts the quarter hour from the last thing somebody typed', async () => {
    // Claude Code says idle while a prompt is being typed and not yet sent, so
    // the registry alone cannot tell a forgotten session from one in use.
    const { sweepAt, held, terminals, clock } = await world({ status: 'idle' });
    const terminalId = terminals.terminals[0]?.terminalId ?? '';

    await sweepAt(0);
    clock.at(10);
    terminals.noteInput(terminalId);

    await sweepAt(15);
    expect(held()).toEqual([]);
    await sweepAt(24.99);
    expect(held()).toEqual([]);
    await sweepAt(25);
    expect(held()).toEqual(['SIGHUP']);
  });

  it('never stops a held codex session, which keeps no registry to say it is idle', async () => {
    // Registered beside an idle claude in the same store, so a sweep that
    // took the first idle it found for anything would find one.
    const { sweepAt, held, records } = await world({ codex: true, outside: 'idle' });

    for (const minute of [0, 15, 30, 60]) await sweepAt(minute);

    expect(held()).toEqual([]);
    expect(idleStops(records)).toEqual([]);
  });

  it('never touches a claude somebody is running outside agentplex', async () => {
    // Idle in the same registry, and nothing here holds it. It is not this
    // server's to stop: no signal goes to its pid, and no stop is attempted.
    const { sweepAt, signaller, records, held } = await world({ outside: 'idle' });

    for (const minute of [0, 15, 30, 60]) await sweepAt(minute);

    expect(signaller.sent).toEqual([]);
    expect(held()).toEqual([]);
    expect(records.filter((record) => record.message === 'session stopped')).toEqual([]);
  });

  it('never stops a held claude because another claude on the same session is idle', async () => {
    // Somebody ran `claude --resume` on the held session in their own terminal
    // and left it at its prompt. Its entry is the newer, so it is the one the
    // registry answers for the session; the claude this server holds is busy.
    const { sweepAt, held, signaller, records } = await world({ status: 'busy', rival: 'idle' });

    for (const minute of [0, 15, 30, 60]) await sweepAt(minute);

    expect(held()).toEqual([]);
    expect(signaller.sent).toEqual([]);
    expect(idleStops(records)).toEqual([]);
  });

  it('sweeps with no hub connected, and reports to nobody', async () => {
    // A forgotten session is most likely on a server nobody is looking at.
    const { sweepAt, held } = await world({ status: 'idle', audience: true });

    await sweepAt(0);
    await sweepAt(15);

    expect(held()).toEqual(['SIGHUP']);
  });

  it('keeps the idle time when the stop is refused on a stale status, and stops at the next sweep', async () => {
    // The terminal's status comes from the last scan, and the scan can still
    // say working after the registry has said idle. The stop refuses that;
    // the session has still been idle all along.
    const { sweepAt, held, terminals, records } = await world({ status: 'idle' });

    await sweepAt(0);
    terminals.observe(HELD, 'working');
    await sweepAt(15);
    expect(held()).toEqual([]);
    expect(idleStops(records)).toEqual([]);

    terminals.observe(HELD, 'idle');
    await sweepAt(16);
    expect(held()).toEqual(['SIGHUP']);
    expect(idleStops(records)[0]?.fields).toMatchObject({ idleMs: 16 * MINUTE });
  });

  it('costs one terminal its pass when the adapter throws, and goes on sweeping', async () => {
    const { sweepAt, held, records, breakRegistry } = await world({ status: 'idle' });

    breakRegistry(true);
    await sweepAt(0);
    expect(
      records.some((record) => record.message === 'could not tell whether a session is idle'),
    ).toBe(true);

    breakRegistry(false);
    await sweepAt(1);
    await sweepAt(15.99);
    expect(held()).toEqual([]);
    await sweepAt(16);

    expect(held()).toEqual(['SIGHUP']);
  });

  it('schedules nothing once it is stopped', async () => {
    const { idle, timers } = await world({ status: 'idle' });
    expect(timers.pending).toBe(1);

    idle.stop();

    expect(timers.pending).toBe(0);
  });
});
