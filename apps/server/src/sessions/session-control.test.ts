import { describe, expect, it } from 'vitest';
import {
  SESSION_BRANCH_MAX_CHARS,
  sessionDescriptorSchema,
  sessionIdSchema,
  storeIdSchema,
  type Provider,
  type StoreDescriptor,
  type UncommittedDiff,
} from '@agentplex/protocol';
import { createLogger, type LogRecord, type Logger } from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProcessProbe,
  createFakeProviderAdapter,
  createFakeProviderFiles,
  readProviderFixture,
  type FakeProcessProbe,
} from '@agentplex/providers/testing';
import {
  createClaudeAdapter,
  createCodexAdapter,
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderFiles,
} from '@agentplex/providers';
import { createDirectoryBrowser } from '../directories/directory-browse.js';
import { createFakeDirectoryReader } from '../directories/fake-directory-reader.js';
import { createFakeWorkingTree, type FakeWorkingTree } from '../working-tree/fake-working-tree.js';
import { createFakeProcessSignaller, type FakeProcessSignaller } from './fake-process-signaller.js';
import type { RetakeSignal } from './process-signaller.js';
import {
  createSessionController,
  RETAKE_BOUND_MS,
  RETAKE_POLL_MS,
  type SessionController,
  type SessionOutcome,
} from './session-control.js';
import {
  createTerminalManager,
  KILL_GRACE_MS,
  type TerminalManager,
} from '../terminal/terminal-manager.js';

/**
 * What one server does with an instruction, without a socket in sight.
 *
 * The end-to-end path is `hub/sessions/session-start.integration.test`; what is
 * asked here is what this machine says no to and why, which is where the rules
 * that protect it live: a store it does not have, a provider it cannot drive, a
 * session that is not there, and a process it is already running.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const STORE: StoreDescriptor = { storeId: WORK, path: '/volumes/work' };

/**
 * The home directory of the account this made-up server runs as.
 *
 * Under no store any machine here mounts, which is how a real server is set up:
 * a store is `<home>/.claude`, under the home and never the other way round.
 */
const HOME = '/home/agentplex';

const PROJECT_DIFF: UncommittedDiff = {
  files: 2,
  added: 20,
  removed: 5,
  entries: [
    { path: 'src/auth/refresh.ts', added: 18, removed: 4 },
    { path: 'src/auth/index.ts', added: 2, removed: 1 },
  ],
};

const STORE_ROOT_DIFF: UncommittedDiff = { files: 0, added: 0, removed: 0, entries: [] };

function session(id: string): ReturnType<typeof sessionIdSchema.parse> {
  return sessionIdSchema.parse(id);
}

interface Machine {
  readonly sessions: SessionController;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  readonly workingTree: FakeWorkingTree;
  /**
   * The store's transcripts as they now stand, by path. Every read goes to
   * what is in here at the time, so a test can have the provider write between
   * two reports.
   */
  readonly transcripts: Record<string, string>;
  /** The process table the real adapter reads, which a test can end a process in. */
  readonly probe: FakeProcessProbe;
  /** Every signal this server sent, and what each process did with it. */
  readonly signaller: FakeProcessSignaller;
  /** The controller's own deadlines: a retake's polls and its grace before SIGKILL. */
  readonly timers: FakeTimers;
}

interface MachineOptions {
  readonly noAdapter?: boolean;
  /** What git found, by directory. Anything not in here was not readable. */
  readonly workingTree?: FakeWorkingTree;
  /**
   * What this machine's operator configured as browsable, or none at all.
   *
   * Default is none, which is what a server ships with: a machine nobody has
   * configured will spawn in no directory an instruction names, and that is the
   * refusal worth having by default in a suite about what this server says no
   * to.
   */
  readonly browseRoots?: readonly string[];
  /** More made-up transcripts in the store, by path, beside the three every machine has. */
  readonly files?: Readonly<Record<string, string>>;
  /** The pid each fake pty reports, in the order they are opened. */
  readonly pids?: readonly number[];
  /** Every pty refuses to open with this message, as a machine that cannot fork does. */
  readonly failsToOpen?: string;
  /** How many terminals the machine keeps before it evicts one. */
  readonly cap?: number;
  /** The home directory of the account the server runs as. Default `HOME`. */
  readonly homeDirectory?: string;
  /**
   * The one store this machine mounts, in place of `STORE`.
   *
   * A start has to name it by its own id, or it is refused as not mounted
   * before it reaches anything a case here is about.
   */
  readonly store?: StoreDescriptor;
  /**
   * The real Claude adapter in place of the fake one.
   *
   * The fake passes whatever cwd it is handed straight to its plan, so a rule
   * the real planner applies to that cwd is invisible behind it.
   */
  readonly realAdapter?: boolean;
  /**
   * The processes the real adapter's probe finds alive, by pid, each with the
   * epoch ms it started at. Set at construction, so a test registers its
   * spawn's pid up front; one ends through `probe.exit` or a signal.
   */
  readonly processes?: Readonly<Record<number, number>>;
  /** Live pids the probe cannot date. */
  readonly undatable?: readonly number[];
  /**
   * The signal a process outside agentplex ends on. `SIGHUP` (the default)
   * ends on either, `SIGKILL` catches SIGHUP and carries on, and `nothing` is
   * a process no signal ends -- one stuck in the kernel.
   */
  readonly obeys?: 'SIGHUP' | 'SIGKILL' | 'nothing';
  /**
   * What a process does with a signal, in place of `obeys`, for the cases that
   * are more than ending: a claude that drops its registry entry and runs on,
   * or a pid the kernel hands to somebody else. The process table and the
   * store are separate, as they are on a real machine.
   */
  readonly onSignal?: (
    pid: number,
    signal: RetakeSignal,
    machine: Pick<Machine, 'probe' | 'transcripts'>,
  ) => void;
  /** Every signal is refused, as the kernel refuses one to another account's process. */
  readonly refuseSignals?: 'EPERM';
  /** Registers the real codex adapter beside the claude one. */
  readonly codex?: boolean;
  /** Where this machine logs, in place of a sink that drops everything. */
  readonly logger?: Logger;
}

/**
 * The disk the browse rule is applied against.
 *
 * `/checkouts/agentplex` is a directory under a root; `/checkouts/away` is a
 * link out of one, which is the case no string comparison can see and the
 * reason the rule runs on `realpath`.
 */
const DISK = createFakeDirectoryReader({
  directories: {
    '/checkouts': [{ name: 'agentplex', kind: 'directory' }],
    '/checkouts/agentplex': [],
    '/elsewhere/secrets': [],
  },
  links: { '/checkouts/away': '/elsewhere/secrets' },
});

function machine(options: MachineOptions = {}): Machine {
  const transcripts: Record<string, string> = {
    '/volumes/work/claude/sessions/session-1.json': JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START - 1_000,
      cwd: '/volumes/work/project',
      // What this made-up provider records of the work itself, which is
      // what a transcript read answers with. Three, so a bound of two has
      // something to leave behind.
      activities: [
        { kind: 'command', text: 'pnpm install', exitStatus: 0 },
        { kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 },
        { kind: 'command', text: 'pnpm test', exitStatus: 1 },
      ],
    }),
    // A session this provider records no working directory for. Its adapter
    // refuses a resume rather than guessing one, and that refusal has to
    // survive the trip rather than becoming a crash.
    '/volumes/work/claude/sessions/session-homeless.json': JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START - 1_000,
    }),
    // Mid-turn as of its last write, which is what withholds a stop.
    '/volumes/work/claude/sessions/session-busy.json': JSON.stringify({
      signal: 'progressing',
      updatedAt: START - 1_000,
      cwd: '/volumes/work/project',
    }),
    ...options.files,
  };
  // A fresh fake over the record on every read, so a rewrite shows up at the
  // next scan the way a provider's own write would.
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: transcripts }).readFile(path),
    listDirectory: (path) => createFakeProviderFiles({ files: transcripts }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: transcripts }).readFileTail(path, maxBytes),
    stat: (path) => createFakeProviderFiles({ files: transcripts }).stat(path),
  };

  const ptys = createFakePtyFactory({
    ...(options.pids === undefined ? {} : { pids: options.pids }),
    ...(options.failsToOpen === undefined ? {} : { failsToOpen: options.failsToOpen }),
  });
  const terminals = createTerminalManager({
    supervisor: createPtySupervisor({
      pty: ptys,
      clock,
      ids: { newId: () => `run-${ptys.ptys.length}` },
      environment: {},
    }),
    clock,
    timers: createFakeTimers(),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });

  const workingTree = options.workingTree ?? createFakeWorkingTree();
  const probe = createFakeProcessProbe({
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    ...(options.undatable === undefined ? {} : { undatable: options.undatable }),
  });
  const adapter =
    options.realAdapter === true
      ? createClaudeAdapter({
          files,
          probe,
          // The controller's home, so the two answer for one account.
          homeDirectory: options.homeDirectory ?? HOME,
        })
      : createFakeProviderAdapter({ provider: 'claude', files });
  const adapters: ProviderAdapter[] =
    options.codex === true ? [adapter, createCodexAdapter({ files })] : [adapter];
  const obeys = options.obeys ?? 'SIGHUP';
  const signaller = createFakeProcessSignaller({
    ...(options.refuseSignals === undefined ? {} : { refuse: options.refuseSignals }),
    onSignal: (pid, signal) => {
      if (options.onSignal !== undefined) {
        options.onSignal(pid, signal, { probe, transcripts });
        return;
      }
      if (obeys === 'nothing') return;
      if (signal === 'SIGKILL' || obeys === 'SIGHUP') probe.exit(pid);
    },
  });
  const timers = createFakeTimers();

  return {
    transcripts,
    ptys,
    terminals,
    workingTree,
    probe,
    signaller,
    timers,
    sessions: createSessionController({
      stores: [options.store ?? STORE],
      providers: createProviderRegistry(options.noAdapter === true ? [] : adapters),
      terminals,
      workingTree,
      homeDirectory: options.homeDirectory ?? HOME,
      // The real rule over a written-down disk, not a stub that says yes: what
      // a start has to get right is what it does when the directory is outside
      // every root, and a fake that answered by agreement would assert nothing.
      browse: createDirectoryBrowser({
        roots: [...(options.browseRoots ?? [])],
        reader: DISK,
      }),
      // No approvals here: what a launch is handed before it starts has a
      // suite of its own, and every rule in this one is about the directory,
      // the holder and the cap.
      approvals: null,
      signaller,
      processes: probe,
      timers,
      clock,
      logger: options.logger ?? logger,
    }),
  };
}

describe('a start this server will not run', () => {
  it('refuses a store it does not have mounted, rather than running somewhere else', async () => {
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: storeIdSchema.parse('store-elsewhere'),
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused', hold: null });
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a provider this build cannot drive', async () => {
    const { sessions, ptys } = machine({ noAdapter: true });

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused' });
    expect(ptys.opened).toEqual([]);
  });

  it('refuses to resume a session that is not in the store', async () => {
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: session('session-gone'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused' });
    expect(ptys.opened).toEqual([]);
  });

  it("passes on the adapter's own refusal rather than restating it", async () => {
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: session('session-homeless'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('working directory');
    expect(ptys.opened).toEqual([]);
  });
});

describe('a start this server runs', () => {
  it('resumes in the directory the transcript recorded, which no frame supplied', async () => {
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' });
    expect(ptys.opened[0]).toMatchObject({
      args: ['--resume', 'session-1'],
      cwd: '/volumes/work/project',
    });
  });

  it('spawns in the server account home directory when no project is named, with the prompt as one argument', async () => {
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
      directory: null,
    });

    // No session id yet: the provider mints its own and the next scan finds it.
    expect(outcome).toMatchObject({ ok: true, sessionId: null });
    expect(ptys.opened[0]).toMatchObject({
      args: ['look at the failing test'],
      cwd: HOME,
    });
  });

  /**
   * The amended rule, on the machine that enforces it.
   *
   * The directory came off a frame, which is why every assertion here is about
   * what bounds it: an operator listed `/checkouts`, this path is inside it,
   * and the value reaches exactly one spawn field.
   */
  it('spawns in a project directory its operator listed a root above', async () => {
    const { sessions, ptys } = machine({ browseRoots: ['/checkouts'] });

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: '/checkouts/agentplex',
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(ptys.opened[0]).toMatchObject({ cwd: '/checkouts/agentplex', args: [] });
  });

  it('refuses a directory under no root, and forks nothing', async () => {
    const { sessions, ptys } = machine({ browseRoots: ['/checkouts'] });

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: '/elsewhere/secrets',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused', hold: null });
    if (outcome.ok) return;
    // The sentence names the path that was asked for, because that is what the
    // person who picked it will recognise.
    expect(outcome.problem).toContain('/elsewhere/secrets');
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a link out of a root, which the string alone cannot see', async () => {
    const { sessions, ptys } = machine({ browseRoots: ['/checkouts'] });

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: '/checkouts/away',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused' });
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a project start on a machine with no roots, whatever the path', async () => {
    // The default a server ships with: nobody has said this box may run
    // anybody's project, so it runs none and says which setting to change.
    const { sessions, ptys } = machine();

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: '/checkouts/agentplex',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused' });
    if (outcome.ok) return;
    expect(outcome.problem).toContain('AGENTPLEX_BROWSE_ROOTS');
    expect(ptys.opened).toEqual([]);
  });

  /**
   * The hub refuses this too. This is the half that holds when the hub's view
   * is a version behind: a resume runs where its own transcript says it ran,
   * and an instruction asking for two directories gets neither.
   */
  it('refuses a resume that also names a directory, rather than choosing one', async () => {
    const { sessions, ptys } = machine({ browseRoots: ['/checkouts'] });

    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: '/checkouts/agentplex',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'refused' });
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a second start on a session it is already running, and names the hold', async () => {
    const { sessions, ptys } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    // The hub refuses this too, from its own state. This is the same rule where
    // the processes actually are, for the instruction that arrives anyway.
    const second = await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    expect(second).toMatchObject({
      ok: false,
      code: 'refused',
      hold: { sessionId: 'session-1', stoppable: true, pause: 'none' },
    });
    expect(ptys.opened).toHaveLength(1);
  });
});

describe('a resume of a session something else is running', () => {
  const SESSIONS_AT = '/volumes/work/claude/sessions';
  const OUTSIDE_PID = 4242;

  function transcript(fields: Readonly<Record<string, unknown>>): string {
    return JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START - 1_000,
      cwd: '/volumes/work/project',
      ...fields,
    });
  }

  function resume(sessions: SessionController, id: string) {
    return sessions.start({
      storeId: WORK,
      sessionId: session(id),
      provider: 'claude',
      prompt: null,
      directory: null,
    });
  }

  it('refuses a session a verified process outside agentplex runs, in words and with no pid', async () => {
    // A second process on one transcript interleaves its writes with the
    // first and damages the session for both. Somebody's own terminal is
    // running this one; this server holds nothing, so the answer carries no
    // hold, and the pid stays on this machine.
    const { sessions, ptys } = machine({
      files: {
        [`${SESSIONS_AT}/session-outside.json`]: transcript({
          running: true,
          pid: OUTSIDE_PID,
          process: 'verified',
        }),
      },
    });

    const outcome = await resume(sessions, 'session-outside');

    expect(outcome).toMatchObject({ ok: false, code: 'refused', hold: null });
    if (outcome.ok) return;
    expect(outcome.problem).toContain('outside agentplex');
    expect(outcome.problem).not.toMatch(/\d/);
    expect(ptys.opened).toEqual([]);
  });

  it('never calls its own spawn outside agentplex before a report has bound it', async () => {
    // The provider registered the process this server forked, and no report
    // has run since, so the terminal holds no session id yet. A resume of
    // that session is the second start the hold rule refuses, and it names
    // the hold rather than blaming somebody else's terminal.
    const { sessions, ptys } = machine({
      pids: [OUTSIDE_PID],
      files: {
        [`${SESSIONS_AT}/session-ours.json`]: transcript({
          createdAt: START,
          running: true,
          pid: OUTSIDE_PID,
        }),
      },
    });
    const spawned = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    expect(spawned.ok).toBe(true);

    const outcome = await resume(sessions, 'session-ours');

    expect(outcome).toMatchObject({
      ok: false,
      code: 'refused',
      hold: { sessionId: 'session-ours', stoppable: true, pause: 'none' },
    });
    if (outcome.ok) return;
    expect(outcome.problem).not.toContain('outside agentplex');
    expect(ptys.opened).toHaveLength(1);
  });

  it('resumes a session no process was seen running, even when nobody could look', async () => {
    // `unknown` is not a sighting. Refusing on it would make every codex
    // session, and every Claude store this server cannot list, unresumable.
    const { sessions, ptys } = machine({
      files: { [`${SESSIONS_AT}/session-unseen.json`]: transcript({ process: 'unknown' }) },
    });

    const outcome = await resume(sessions, 'session-unseen');

    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-unseen' });
    expect(ptys.opened).toHaveLength(1);
  });
});

/**
 * A start that names no project, against the real Claude adapter.
 *
 * The fallback directory is chosen in this package and judged in another: this
 * controller decides where a no-project start runs, and the providers' working
 * directory guard decides whether a provider may run there. The fake adapter
 * passes a cwd straight through without the guard, so a fallback the guard
 * refuses on every start -- the store's own path, as it used to be -- passes
 * every case above. Only the real planner shows the two contradicting.
 */
describe('a start with no project', () => {
  const CLAUDE_HOME: StoreDescriptor = {
    storeId: storeIdSchema.parse('store-home'),
    path: `${HOME}/.claude`,
  };

  it('runs in the server account home directory, which the store is under', async () => {
    const { sessions, ptys } = machine({
      realAdapter: true,
      store: CLAUDE_HOME,
      homeDirectory: HOME,
    });

    const outcome = await sessions.start({
      storeId: CLAUDE_HOME.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: 'hi',
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: true, sessionId: null });
    expect(ptys.opened[0]?.cwd).toBe(HOME);
  });

  it("leaves the child on the account's own Claude config in its default store", async () => {
    // The store is `~/.claude`, which is where Claude Code looks with no
    // `CLAUDE_CONFIG_DIR` at all. Naming it would move the child's global
    // config and keychain item, and the session would open on onboarding,
    // logged out. The supervisor scrubs an inherited one, so absent here is
    // absent in the child.
    const { sessions, ptys } = machine({
      realAdapter: true,
      store: CLAUDE_HOME,
      homeDirectory: HOME,
    });

    const outcome = await sessions.start({
      storeId: CLAUDE_HOME.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: 'hi',
      directory: null,
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(ptys.opened[0]?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('refuses, naming the store, when the home directory is the store', async () => {
    // A server account whose HOME was pointed at its own store. The guard is
    // unchanged by the fallback moving: an agent started in the store would be
    // editing the transcripts agentplex reads, so it starts nowhere and says
    // why in words an operator can act on.
    const { sessions, ptys } = machine({
      realAdapter: true,
      store: CLAUDE_HOME,
      homeDirectory: CLAUDE_HOME.path,
    });

    const outcome = await sessions.start({
      storeId: CLAUDE_HOME.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: 'hi',
      directory: null,
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problem).toContain('is the store');
    expect(ptys.opened).toEqual([]);
  });
});

describe('a report', () => {
  it('says what is in the store and what this server is holding', async () => {
    const { sessions } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    const report = await sessions.report(WORK);

    expect(report?.sessions.map((one) => one.sessionId).sort()).toEqual([
      'session-1',
      'session-busy',
      'session-homeless',
    ]);
    expect(report?.holding).toEqual([{ sessionId: 'session-1', stoppable: true, pause: 'none' }]);
  });

  it('withholds the stop from a session that is mid-turn', async () => {
    const { sessions } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-busy'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    // The status is the adapter's, derived on the scan the report makes, and
    // it is what the hold is answered with. Nothing above the adapter decides
    // what mid-turn means for a provider.
    const report = await sessions.report(WORK);
    expect(report?.holding).toEqual([
      { sessionId: 'session-busy', stoppable: false, pause: 'none' },
    ]);
  });

  it('answers nothing for a store this server does not have', async () => {
    const { sessions } = machine();
    expect(await sessions.report(storeIdSchema.parse('store-elsewhere'))).toBeNull();
  });

  it('carries what git says is uncommitted in each session own directory', async () => {
    // Two directories in one store: the two sessions the provider recorded a
    // cwd for, and the one it did not, which falls back to the store's own
    // path. The point is that the fallback is the store and not the other
    // session's checkout -- a diffstat attributed to the wrong tree is worse
    // than none.
    const { sessions, workingTree } = machine({
      workingTree: createFakeWorkingTree({
        '/volumes/work/project': PROJECT_DIFF,
        '/volumes/work': STORE_ROOT_DIFF,
      }),
    });

    const report = await sessions.report(WORK);
    const byId = new Map(report?.sessions.map((one) => [one.sessionId, one.uncommitted]));

    expect(byId.get(session('session-1'))).toEqual(PROJECT_DIFF);
    expect(byId.get(session('session-busy'))).toEqual(PROJECT_DIFF);
    expect(byId.get(session('session-homeless'))).toEqual(STORE_ROOT_DIFF);
    // Two sessions share a checkout and it was read once.
    expect([...workingTree.askedUncommitted].sort()).toEqual([
      '/volumes/work',
      '/volumes/work/project',
    ]);
  });

  it('carries the branch each session own directory is on', async () => {
    // The same fallback rule as the diffstat, for the same reason: a branch
    // attributed to the wrong checkout is worse than none. Read in the same
    // pass, so the branch and the diffstat on one descriptor are two answers
    // about one tree at one moment.
    const { sessions, workingTree } = machine({
      workingTree: createFakeWorkingTree(
        {},
        { '/volumes/work/project': 'fix/auth-refresh', '/volumes/work': 'master' },
      ),
    });

    const report = await sessions.report(WORK);
    const byId = new Map(report?.sessions.map((one) => [one.sessionId, one.branch]));

    expect(byId.get(session('session-1'))).toBe('fix/auth-refresh');
    expect(byId.get(session('session-busy'))).toBe('fix/auth-refresh');
    expect(byId.get(session('session-homeless'))).toBe('master');
    expect([...workingTree.askedBranch].sort()).toEqual(['/volumes/work', '/volumes/work/project']);
  });

  it('reports no branch rather than a prefix of one too long for the wire', async () => {
    // git sets no bound on a ref name and the descriptor does. A clipped name
    // is not the branch the checkout is on -- it is another branch, or none --
    // so a name past the bound is shown as no branch, which claims nothing,
    // and the descriptor carrying it still parses rather than costing the
    // store report every session in it rides on.
    const long = `feature/${'x'.repeat(SESSION_BRANCH_MAX_CHARS)}`;
    const { sessions } = machine({
      workingTree: createFakeWorkingTree(
        {},
        { '/volumes/work/project': long, '/volumes/work': 'master' },
      ),
    });

    const report = await sessions.report(WORK);
    const byId = new Map(report?.sessions.map((one) => [one.sessionId, one]));

    expect(byId.get(session('session-1'))?.branch).toBeNull();
    expect(byId.get(session('session-homeless'))?.branch).toBe('master');
    for (const one of report?.sessions ?? []) {
      expect(sessionDescriptorSchema.safeParse(one).success).toBe(true);
    }
  });

  it('reports no branch rather than a guess when git could not be asked', async () => {
    // A detached head and a directory nobody read are the same `null` here, and
    // both draw nothing. Neither claims anything about the checkout, which is
    // why this field does not distinguish them and the diffstat does.
    const { sessions } = machine();

    const report = await sessions.report(WORK);

    expect(report?.sessions.map((one) => one.branch)).toEqual([null, null, null]);
  });

  it('reports no diffstat rather than an empty one when git could not be asked', async () => {
    // The default machine has a reader that answers nothing, which is what a
    // server with no git on it, or a store that is not a repository, looks
    // like. `null` and not `{ files: 0 }`: a zero says a person has nothing
    // outstanding, and nobody looked.
    const { sessions } = machine();

    const report = await sessions.report(WORK);

    expect(report?.sessions.map((one) => one.uncommitted)).toEqual([null, null, null]);
  });
});

/**
 * Which session a spawn turned out to be.
 *
 * Every terminal here starts at `START`, silent -- no prompt, so nothing the
 * provider writes can be told apart by content -- and every session sits in a
 * made-up transcript beside the three every machine has, which were written
 * before `START` and so are never candidates.
 */
describe('binding a spawned terminal', () => {
  const SESSIONS_AT = '/volumes/work/claude/sessions';

  function transcript(fields: Readonly<Record<string, unknown>>): string {
    return JSON.stringify({ signal: 'awaiting-input', cwd: '/volumes/work/project', ...fields });
  }

  async function spawnSilently(sessions: SessionController): Promise<string> {
    const outcome = await sessions.start({
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    if (!outcome.ok) throw new Error(`the spawn was refused: ${outcome.problem}`);
    return outcome.terminalId;
  }

  it('leaves a session that began before the terminal to whoever began it', async () => {
    // The case the last write got wrong. Somebody opened this session a
    // minute ago in their own terminal and spoke to it half a second after
    // ours started; its last write is after our start, its first is not, and
    // a session cannot have been created by a process that did not yet exist.
    const { sessions, terminals } = machine({
      files: {
        [`${SESSIONS_AT}/session-theirs.json`]: transcript({
          createdAt: START - 60_000,
          updatedAt: START + 500,
        }),
      },
    });
    const terminalId = await spawnSilently(sessions);

    const report = await sessions.report(WORK);

    expect(report?.holding).toEqual([]);
    expect(terminals.terminal(terminalId)?.session).toBeNull();
  });

  it('binds nothing when two sessions began after the terminal did', async () => {
    // Either could be ours, and a wrong guess is a claim to hold somebody
    // else's session. The next scan, or the pid, settles it.
    const { sessions, terminals } = machine({
      files: {
        [`${SESSIONS_AT}/session-one.json`]: transcript({
          createdAt: START + 1,
          updatedAt: START + 1,
        }),
        [`${SESSIONS_AT}/session-two.json`]: transcript({
          createdAt: START + 2,
          updatedAt: START + 2,
        }),
      },
    });
    const terminalId = await spawnSilently(sessions);

    const report = await sessions.report(WORK);

    expect(report?.holding).toEqual([]);
    expect(terminals.terminal(terminalId)?.session).toBeNull();
  });

  it('binds the one session that began after the terminal did, and reports the hold', async () => {
    const { sessions, terminals } = machine({
      files: {
        [`${SESSIONS_AT}/session-ours.json`]: transcript({
          createdAt: START + 1,
          updatedAt: START + 1,
        }),
      },
    });
    const terminalId = await spawnSilently(sessions);

    const report = await sessions.report(WORK);

    expect(report?.holding).toEqual([
      { sessionId: 'session-ours', stoppable: true, pause: 'none' },
    ]);
    expect(terminals.terminal(terminalId)?.session).toEqual({
      storeId: WORK,
      sessionId: 'session-ours',
    });
  });

  it('binds the session whose verified pid is the terminal own, whatever its dates', async () => {
    // The provider registered the very process this server forked. No other
    // session's timing can confuse that, so the dates are not consulted --
    // even a second session that began after the terminal does not make it
    // ambiguous.
    const { sessions, terminals } = machine({
      pids: [4242],
      files: {
        [`${SESSIONS_AT}/session-ours.json`]: transcript({
          createdAt: START - 60_000,
          updatedAt: START - 1_000,
          running: true,
          pid: 4242,
        }),
        [`${SESSIONS_AT}/session-later.json`]: transcript({
          createdAt: START + 1,
          updatedAt: START + 1,
        }),
      },
    });
    const terminalId = await spawnSilently(sessions);

    const report = await sessions.report(WORK);

    expect(report?.holding).toEqual([
      { sessionId: 'session-ours', stoppable: true, pause: 'none' },
    ]);
    expect(terminals.terminal(terminalId)?.session).toEqual({
      storeId: WORK,
      sessionId: 'session-ours',
    });
  });

  it('binds a prompt-less claude to the id it registered, before any turn is written', async () => {
    // The real adapter over a store with no transcript at all. Claude Code
    // registers `sessions/<pid>.json` before anyone types (2.1.287, checked
    // at the origin for AGX-373), and the pid in it is the process the pty
    // forked, because the launch execs claude with no shell between.
    const CLAUDE_HOME: StoreDescriptor = {
      storeId: storeIdSchema.parse('store-home'),
      path: `${HOME}/.claude`,
    };
    const PID = 4242;
    const SESSION = '5df6a5a1-1c69-4713-9c09-e05a0dbbee62';
    const records: LogRecord[] = [];
    const { sessions, terminals, transcripts } = machine({
      realAdapter: true,
      store: CLAUDE_HOME,
      pids: [PID],
      processes: { [PID]: START },
      logger: createLogger('debug', (record) => records.push(record)),
    });

    const outcome = await sessions.start({
      storeId: CLAUDE_HOME.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    if (!outcome.ok) throw new Error(`the spawn was refused: ${outcome.problem}`);

    // What the forked claude writes a beat after it starts: the captured
    // entry, with only the pid, the id and the dates bent to this spawn.
    transcripts[`${CLAUDE_HOME.path}/sessions/${PID}.json`] = JSON.stringify({
      ...JSON.parse(await readProviderFixture('claude-session-registry.json')),
      pid: PID,
      sessionId: SESSION,
      cwd: HOME,
      startedAt: START + 1_302,
      status: 'idle',
      statusUpdatedAt: START + 1_302,
    });

    const report = await sessions.report(CLAUDE_HOME.storeId);

    expect(terminals.terminal(outcome.terminalId)?.session).toEqual({
      storeId: CLAUDE_HOME.storeId,
      sessionId: SESSION,
    });
    expect(report?.sessions.map((one) => [one.sessionId, one.cwd])).toEqual([[SESSION, HOME]]);
    expect(report?.holding.map((hold) => hold.sessionId)).toEqual([SESSION]);
    expect(records.map((record) => record.message)).not.toContain(
      'a spawned terminal has no session id yet',
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'spawned terminal bound to its session',
        fields: expect.objectContaining({ sessionId: SESSION, by: 'pid' }),
      }),
    );
  });

  it('never binds a session another verified process is running, however its dates fit', async () => {
    // Started after ours and alone in the store, so timing alone would take
    // it. But its provider names the process running it, and that process is
    // not the one this server forked: a claim to hold it would be false.
    const { sessions, terminals } = machine({
      pids: [4242],
      files: {
        [`${SESSIONS_AT}/session-theirs.json`]: transcript({
          createdAt: START + 1,
          updatedAt: START + 1,
          running: true,
          pid: 777,
        }),
      },
    });
    const terminalId = await spawnSilently(sessions);

    const report = await sessions.report(WORK);

    expect(report?.holding).toEqual([]);
    expect(terminals.terminal(terminalId)?.session).toBeNull();
  });

  /**
   * One of our own terminals held a session and has since exited.
   *
   * Once the process is gone the provider stops vouching for it, so the
   * session loses its pid, no live terminal holds it, and it began after every
   * terminal here did: timing alone would hand it to the next unbound spawn.
   * But this server knows whose it was.
   */
  describe('after a terminal that had a session exits', () => {
    const PROMPTED = `${SESSIONS_AT}/session-prompted.json`;

    async function spawnPrompted(sessions: SessionController): Promise<string> {
      const outcome = await sessions.start({
        storeId: WORK,
        sessionId: null,
        provider: 'claude',
        prompt: 'fix the build',
        directory: null,
      });
      if (!outcome.ok) throw new Error(`the spawn was refused: ${outcome.problem}`);
      return outcome.terminalId;
    }

    /** The prompted terminal's process exits, and with it the provider's word that anything runs the session. */
    function exitPrompted({ ptys, transcripts }: Machine): void {
      ptys.ptys[1]?.close({ exitCode: 0, signal: null });
      transcripts[PROMPTED] = transcript({ createdAt: START + 1, updatedAt: START + 2 });
    }

    const running = {
      [PROMPTED]: transcript({
        createdAt: START + 1,
        updatedAt: START + 1,
        running: true,
        pid: 2222,
      }),
    };

    it('never hands that session to a terminal still waiting for its own', async () => {
      const world = machine({ pids: [1111, 2222], files: running });
      const { sessions, terminals } = world;
      const silent = await spawnSilently(sessions);
      const prompted = await spawnPrompted(sessions);

      const first = await sessions.report(WORK);
      expect(first?.holding).toEqual([
        { sessionId: 'session-prompted', stoppable: true, pause: 'none' },
      ]);
      expect(terminals.terminal(prompted)?.session?.sessionId).toBe('session-prompted');

      exitPrompted(world);
      const second = await sessions.report(WORK);

      expect(second?.holding).toEqual([]);
      expect(terminals.terminal(silent)?.session).toBeNull();
    });

    it('still never hands it over once the exited terminal has been evicted', async () => {
      // An exited terminal is the first thing the cap closes, and with it goes
      // the terminal table's only record that the session was ours.
      const world = machine({ cap: 2, pids: [1111, 2222, 3333], files: running });
      const { sessions, terminals } = world;
      const silent = await spawnSilently(sessions);
      const prompted = await spawnPrompted(sessions);
      await sessions.report(WORK);

      exitPrompted(world);
      const later = await spawnSilently(sessions);
      expect(terminals.terminal(prompted)).toBeUndefined();

      const report = await sessions.report(WORK);

      expect(report?.holding).toEqual([]);
      expect(terminals.terminal(silent)?.session).toBeNull();
      expect(terminals.terminal(later)?.session).toBeNull();
    });
  });
});

/**
 * A retake: ending a claude somebody's own terminal is running, and resuming
 * its session here.
 *
 * Against the real Claude adapter, the captured transcript and the captured
 * registry entry, with only the pid, the id and the dates bent, because every
 * refusal below is a judgement the adapter makes out of those files and a fake
 * adapter would only repeat what the test told it. What a process does with a
 * signal is the one thing written down: the fake signaller ends the pid in the
 * fake process table, and the controller finds out the way it would for real,
 * by asking the registry again.
 */
describe('a retake of a session a claude outside agentplex is running', () => {
  const SESSION = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';
  const OUTSIDE_PID = 5_150;
  const NEW_PID = 6_160;
  const REGISTERED_AT = START - 600_000;
  /** As far before its entry as the captured process started before its own. */
  const OUTSIDE_STARTED_AT = REGISTERED_AT - 1_669;
  const TRANSCRIPT = `${STORE.path}/projects/-Users-dev-Code-agentplex/${SESSION}.jsonl`;
  const ENTRY = `${STORE.path}/sessions/${OUTSIDE_PID}.json`;

  async function outsideClaude(
    entry: Readonly<Record<string, unknown>>,
    options: MachineOptions & { readonly transcript?: boolean } = {},
  ): Promise<Machine> {
    const files: Record<string, string> = {
      [ENTRY]: JSON.stringify({
        ...JSON.parse(await readProviderFixture('claude-session-registry.json')),
        pid: OUTSIDE_PID,
        sessionId: SESSION,
        startedAt: REGISTERED_AT,
        statusUpdatedAt: REGISTERED_AT,
        ...entry,
      }),
    };
    if (options.transcript !== false) {
      files[TRANSCRIPT] = await readProviderFixture('claude-completed-turn.jsonl');
    }
    return machine({
      realAdapter: true,
      pids: [NEW_PID],
      processes: { [OUTSIDE_PID]: OUTSIDE_STARTED_AT },
      ...options,
      files: { ...files, ...options.files },
    });
  }

  function retake(sessions: SessionController, provider: Provider = 'claude') {
    return sessions.retake({ storeId: WORK, sessionId: session(SESSION), provider });
  }

  /** Lets every promise that can move, move, as the event loop would between two timers. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Fires the controller's next poll, `times` over, and lets each one finish. */
  async function poll(timers: FakeTimers, times = 1): Promise<void> {
    for (let fired = 0; fired < times; fired += 1) {
      expect(timers.delays).toEqual([RETAKE_POLL_MS]);
      timers.fireAll();
      await settle();
    }
  }

  function refusal(outcome: SessionOutcome): string {
    if (outcome.ok) throw new Error('the retake was not refused');
    return outcome.problem;
  }

  it.each(['idle', 'waiting'])(
    'ends a claude at registry status %s with SIGHUP, then resumes the session here under its id',
    async (status) => {
      const { sessions, signaller, ptys, timers } = await outsideClaude({ status });

      const pending = retake(sessions);
      await settle();

      // Signalled, and nothing forked yet: the resume waits for the process
      // to be seen gone, because two processes on one transcript damage it.
      expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
      expect(ptys.opened).toEqual([]);

      await poll(timers);
      const outcome = await pending;

      expect(outcome).toMatchObject({ ok: true, storeId: WORK, sessionId: SESSION });
      expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
      expect(ptys.opened).toHaveLength(1);
      expect(ptys.opened[0]?.args).toEqual(expect.arrayContaining(['--resume', SESSION]));
      // Where its own transcript says it ran, as any resume does.
      expect(ptys.opened[0]?.cwd).toBe('/Users/dev/Code/agentplex');
      expect(timers.pending).toBe(0);
    },
  );

  it.each([
    ['busy', 'busy'],
    ['shell', 'shell'],
    ['no status at all', undefined],
  ])('refuses a claude at %s as working elsewhere, and signals nothing', async (_label, status) => {
    const { sessions, signaller, ptys } = await outsideClaude({ status });

    const problem = refusal(await retake(sessions));

    expect(problem).toContain('working elsewhere');
    expect(problem).toContain('idle or waiting');
    expect(problem).not.toMatch(/\d/);
    expect(signaller.sent).toEqual([]);
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a claude running a shell command though its status says it is not at work', async () => {
    // Status follows Claude Code's own reduction of `shell` to idle, so the
    // row does not read as working. Ending the process would end the command
    // somebody typed, so a retake reads the same entry as work.
    const { sessions, signaller } = await outsideClaude({ status: 'shell' });

    const report = await sessions.report(WORK);
    const row = report?.sessions.find((one) => one.sessionId === SESSION);
    expect(row?.status).not.toBe('working');
    expect(row?.process).toBe('running');

    expect(refusal(await retake(sessions))).toContain('working elsewhere');
    expect(signaller.sent).toEqual([]);
  });

  it.each([
    ['whose pid is dead', {}],
    ['whose pid was issued after the entry was written', { [OUTSIDE_PID]: REGISTERED_AT + 60_000 }],
    [
      'whose pid was running well before the entry registered',
      { [OUTSIDE_PID]: REGISTERED_AT - 60_000 },
    ],
  ])('refuses an entry %s, and signals nothing', async (_label, processes) => {
    const { sessions, signaller, ptys } = await outsideClaude({ status: 'idle' }, { processes });

    expect(refusal(await retake(sessions))).toContain('cannot tell which process runs');
    expect(signaller.sent).toEqual([]);
    expect(ptys.opened).toEqual([]);
  });

  it('refuses a live pid this machine cannot date, and signals nothing', async () => {
    const { sessions, signaller } = await outsideClaude(
      { status: 'idle' },
      { processes: {}, undatable: [OUTSIDE_PID] },
    );

    expect(refusal(await retake(sessions))).toContain('cannot tell which process runs');
    expect(signaller.sent).toEqual([]);
  });

  it('sends SIGKILL to a claude that ignores SIGHUP, after the grace, then resumes', async () => {
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      { obeys: 'SIGKILL' },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, KILL_GRACE_MS / RETAKE_POLL_MS - 1);
    expect(signaller.sent.map((sent) => sent.signal)).toEqual(['SIGHUP']);

    await poll(timers);
    expect(signaller.sent).toEqual([
      { pid: OUTSIDE_PID, signal: 'SIGHUP' },
      { pid: OUTSIDE_PID, signal: 'SIGKILL' },
    ]);
    expect(ptys.opened).toEqual([]);

    await poll(timers);
    expect(await pending).toMatchObject({ ok: true, sessionId: SESSION });
    expect(ptys.opened).toHaveLength(1);
  });

  it('logs every signal it sends with the pid it sent it to', async () => {
    // A signal to a process this server did not start is the one act here an
    // operator may have to account for afterwards, and the pid is what names
    // the process on that machine.
    const records: LogRecord[] = [];
    const { sessions, timers } = await outsideClaude(
      { status: 'idle' },
      { obeys: 'SIGKILL', logger: createLogger('info', (record) => records.push(record)) },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, KILL_GRACE_MS / RETAKE_POLL_MS + 1);
    await pending;

    const signalled = records.filter((record) => record.message === 'session retake signalled');
    expect(signalled.map((record) => record.fields)).toEqual([
      expect.objectContaining({ pid: OUTSIDE_PID, signal: 'SIGHUP' }),
      expect.objectContaining({ pid: OUTSIDE_PID, signal: 'SIGKILL' }),
    ]);
  });

  it('refuses at the bound when the process is still there, and resumes nothing', async () => {
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      { obeys: 'nothing' },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, RETAKE_BOUND_MS / RETAKE_POLL_MS);

    expect(RETAKE_BOUND_MS).toBe(KILL_GRACE_MS + 2_000);
    expect(refusal(await pending)).toContain('did not end');
    expect(signaller.sent.map((sent) => sent.signal)).toEqual(['SIGHUP', 'SIGKILL']);
    expect(ptys.opened).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it('waits on the pid rather than the entry, killing a claude that dropped its entry and ran on', async () => {
    // Claude Code removes its own registry entry while it handles SIGHUP, and
    // goes on to run its SessionEnd hooks and flush its transcript. The entry
    // is gone while the process is not, and a resume then would be a second
    // writer on a transcript the first is still writing.
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      {
        onSignal: (pid, signal, { probe, transcripts }) => {
          delete transcripts[ENTRY];
          if (signal === 'SIGKILL') probe.exit(pid);
        },
      },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, KILL_GRACE_MS / RETAKE_POLL_MS - 1);
    expect(signaller.sent.map((sent) => sent.signal)).toEqual(['SIGHUP']);
    expect(ptys.opened).toEqual([]);

    await poll(timers);
    expect(signaller.sent).toEqual([
      { pid: OUTSIDE_PID, signal: 'SIGHUP' },
      { pid: OUTSIDE_PID, signal: 'SIGKILL' },
    ]);
    expect(ptys.opened).toEqual([]);

    await poll(timers);
    expect(await pending).toMatchObject({ ok: true, sessionId: SESSION });
    expect(ptys.opened).toHaveLength(1);
  });

  it('refuses at the bound when a claude dropped its entry and no signal ends it', async () => {
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      {
        onSignal: (_pid, _signal, { transcripts }) => {
          delete transcripts[ENTRY];
        },
      },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, RETAKE_BOUND_MS / RETAKE_POLL_MS);

    expect(refusal(await pending)).toContain('did not end');
    expect(signaller.sent.map((sent) => sent.signal)).toEqual(['SIGHUP', 'SIGKILL']);
    expect(ptys.opened).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it('counts the process ended when its pid now holds a later process, and kills nothing more', async () => {
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      {
        onSignal: (pid, _signal, { probe }) => {
          probe.exit(pid);
          probe.start(pid, START + 1_000);
        },
      },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers);

    expect(await pending).toMatchObject({ ok: true, sessionId: SESSION });
    expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
    expect(ptys.opened).toHaveLength(1);
  });

  it('neither ends nor kills a pid that now dates earlier, a clock step, and refuses at the bound', async () => {
    // The kernel reissues a pid only to a process started after the one that
    // held it. An earlier date is the clock having stepped under the probe,
    // which re-reads boot time per call on Linux: the same process, read
    // wrong, and no proof that it has gone.
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      {
        onSignal: (pid, _signal, { probe }) => {
          probe.exit(pid);
          probe.start(pid, OUTSIDE_STARTED_AT - 60_000);
        },
      },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, RETAKE_BOUND_MS / RETAKE_POLL_MS);

    expect(refusal(await pending)).toContain('could not tell whether');
    expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
    expect(ptys.opened).toEqual([]);
  });

  it('neither ends nor kills a pid it can no longer date, and refuses at the bound', async () => {
    // Alive and undatable is a process this server cannot tell from a later
    // one. Counting it ended would risk two writers; a SIGKILL might land on
    // a stranger.
    const { sessions, signaller, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      {
        onSignal: (pid, _signal, { probe }) => {
          probe.exit(pid);
          probe.start(pid, null);
        },
      },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers, RETAKE_BOUND_MS / RETAKE_POLL_MS);

    expect(refusal(await pending)).toContain('could not tell whether');
    expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
    expect(ptys.opened).toEqual([]);
  });

  describe('refusing before anything is signalled what the resume after it would refuse', () => {
    // Every one of these would otherwise end somebody's claude and then say
    // no: the process is gone and nothing took its place.
    it('refuses while this server is shutting down', async () => {
      const { sessions, terminals, signaller, ptys } = await outsideClaude({ status: 'idle' });
      terminals.seal();

      expect(refusal(await retake(sessions))).toBe('this server is shutting down');
      expect(signaller.sent).toEqual([]);
      expect(ptys.opened).toEqual([]);
    });

    it('refuses at the terminal cap when every terminal is being watched', async () => {
      const { sessions, terminals, signaller, ptys } = await outsideClaude(
        { status: 'idle' },
        { cap: 1, pids: [NEW_PID, NEW_PID + 1] },
      );
      const opened = terminals.spawn(STORE, {
        ok: true,
        plan: { command: 'claude', args: [], cwd: '/checkouts', env: {}, scrubEnvPrefixes: [] },
      });
      if (!opened.ok) throw new Error(opened.problem);
      terminals.terminal(opened.terminal.terminalId)?.watch('a-hub', () => {});

      expect(refusal(await retake(sessions))).toContain('terminal cap of 1');
      expect(signaller.sent).toEqual([]);
      expect(ptys.opened).toHaveLength(1);
    });

    it('refuses a session whose working directory no launch would run in', async () => {
      // Inside the store, which the launch planner refuses whoever asks.
      const transcript = (await readProviderFixture('claude-completed-turn.jsonl')).replaceAll(
        '/Users/dev/Code/agentplex',
        `${STORE.path}/inside`,
      );
      const { sessions, signaller, ptys } = await outsideClaude(
        { status: 'idle' },
        { files: { [TRANSCRIPT]: transcript } },
      );

      expect(refusal(await retake(sessions))).toContain(`${STORE.path}/inside`);
      expect(signaller.sent).toEqual([]);
      expect(ptys.opened).toEqual([]);
    });
  });

  it('says the process was stopped when the launch after it fails', async () => {
    // The one refusal no check can get ahead of: whether this machine can fork
    // is learned by forking, and by then the outside claude has gone.
    const { sessions, signaller, timers } = await outsideClaude(
      { status: 'idle' },
      { failsToOpen: 'posix_spawnp failed.' },
    );

    const pending = retake(sessions);
    await settle();
    await poll(timers);
    const problem = refusal(await pending);

    expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
    expect(problem).toContain('was stopped, but it could not be started here');
    expect(problem).toContain('posix_spawnp failed.');
  });

  it('refuses in words when the process belongs to another account', async () => {
    const { sessions, ptys, timers } = await outsideClaude(
      { status: 'idle' },
      { refuseSignals: 'EPERM' },
    );

    const problem = refusal(await retake(sessions));

    expect(problem).toContain('another account');
    expect(ptys.opened).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it('refuses a codex session, whose process this server cannot name', async () => {
    const { sessions, signaller } = await outsideClaude({ status: 'idle' }, { codex: true });

    expect(refusal(await retake(sessions, 'codex'))).toContain('cannot tell which process runs it');
    expect(signaller.sent).toEqual([]);
  });

  it('refuses a session this server already holds, and names the hold', async () => {
    // The outside claude has exited and this server resumed the session.
    const { sessions, signaller, ptys } = await outsideClaude(
      { status: 'idle' },
      { processes: {} },
    );
    const resumed = await sessions.start({
      storeId: WORK,
      sessionId: session(SESSION),
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    expect(resumed.ok).toBe(true);

    const outcome = await retake(sessions);

    expect(outcome).toMatchObject({ ok: false, code: 'refused', hold: { sessionId: SESSION } });
    expect(refusal(outcome)).toContain('already running');
    expect(signaller.sent).toEqual([]);
    expect(ptys.opened).toHaveLength(1);
  });

  it('refuses a claude with no transcript to resume from, and signals nothing', async () => {
    // A claude nobody has spoken to yet has a registry entry and no
    // transcript, and `--resume` has nothing to resume. Ending it would close
    // somebody's terminal for no session at all.
    const { sessions, signaller } = await outsideClaude({ status: 'idle' }, { transcript: false });

    expect(refusal(await retake(sessions))).toContain('no transcript');
    expect(signaller.sent).toEqual([]);
  });

  describe('while a retake waits for the process it signalled to go', () => {
    // The signalled claude has dropped its entry and its pid may already be
    // dead while it flushes, so a scan in that window sees nothing running the
    // session. Only this server knows a takeover is in flight.
    function resume(sessions: SessionController) {
      return sessions.start({
        storeId: WORK,
        sessionId: session(SESSION),
        provider: 'claude',
        prompt: null,
        directory: null,
      });
    }

    it('refuses a start of that session, and launches nothing', async () => {
      const { sessions, ptys, timers } = await outsideClaude({ status: 'idle' });

      const pending = retake(sessions);
      await settle();
      const started = await resume(sessions);

      expect(started).toMatchObject({ ok: false, code: 'refused', hold: null });
      expect(refusal(started)).toContain('agentplex is taking that session over');
      expect(ptys.opened).toEqual([]);

      await poll(timers);
      expect(await pending).toMatchObject({ ok: true, sessionId: SESSION });
      expect(ptys.opened).toHaveLength(1);
    });

    it('refuses a second retake of that session, and signals nothing more', async () => {
      const { sessions, signaller, ptys, timers } = await outsideClaude({ status: 'idle' });

      const pending = retake(sessions);
      await settle();
      const second = await retake(sessions);

      expect(refusal(second)).toContain('agentplex is taking that session over');
      expect(signaller.sent).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);

      await poll(timers);
      expect(await pending).toMatchObject({ ok: true, sessionId: SESSION });
      expect(ptys.opened).toHaveLength(1);
    });

    it('lets a start through once a retake has resumed the session, to the hold rule', async () => {
      const { sessions, timers } = await outsideClaude({ status: 'idle' });

      const pending = retake(sessions);
      await settle();
      await poll(timers);
      expect((await pending).ok).toBe(true);

      const started = await resume(sessions);
      expect(started).toMatchObject({ ok: false, hold: { sessionId: SESSION } });
      expect(refusal(started)).toContain('already running');
    });

    it('lets a start through once a retake has been refused at the bound', async () => {
      const { sessions, ptys, probe, timers, transcripts } = await outsideClaude(
        { status: 'idle' },
        { obeys: 'nothing' },
      );

      const pending = retake(sessions);
      await settle();
      await poll(timers, RETAKE_BOUND_MS / RETAKE_POLL_MS);
      expect(refusal(await pending)).toContain('did not end');

      // The outside claude ends on its own afterwards.
      probe.exit(OUTSIDE_PID);
      delete transcripts[ENTRY];

      expect(await resume(sessions)).toMatchObject({ ok: true, sessionId: SESSION });
      expect(ptys.opened).toHaveLength(1);
    });
  });

  it('refuses a store it does not have and a provider it cannot drive', async () => {
    const { sessions, signaller } = await outsideClaude({ status: 'idle' });

    const elsewhere = await sessions.retake({
      storeId: storeIdSchema.parse('store-elsewhere'),
      sessionId: session(SESSION),
      provider: 'claude',
    });
    const opencode = await retake(sessions, 'opencode');

    expect(elsewhere).toMatchObject({ ok: false, code: 'refused', hold: null });
    expect(opencode).toMatchObject({ ok: false, code: 'refused', hold: null });
    expect(signaller.sent).toEqual([]);
  });
});

describe('a stop', () => {
  it('resolves the terminal from the session and kills the process', async () => {
    const { sessions, ptys } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });

    const outcome = sessions.stop({ storeId: WORK, sessionId: session('session-1') });

    expect(outcome).toMatchObject({ ok: true, sessionId: 'session-1' });
    expect(ptys.last?.kills).toBe(1);
  });

  it('refuses a session it is not running', () => {
    const { sessions } = machine();

    const outcome = sessions.stop({ storeId: WORK, sessionId: session('session-1') });

    expect(outcome).toMatchObject({ ok: false, code: 'refused', hold: null });
  });

  it('refuses to interrupt a turn, and says the session is held', async () => {
    const { sessions, terminals, ptys } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    terminals.observe({ storeId: WORK, sessionId: session('session-1') }, 'working');

    const outcome = sessions.stop({ storeId: WORK, sessionId: session('session-1') });

    expect(outcome).toMatchObject({
      ok: false,
      code: 'refused',
      hold: { sessionId: 'session-1', stoppable: false, pause: 'none' },
    });
    expect(ptys.last?.kills).toBe(0);
  });
});

describe('a pause and a resume', () => {
  const SESSION_1 = { storeId: WORK, sessionId: session('session-1') };

  async function running() {
    const made = machine();
    await made.sessions.start({ ...SESSION_1, provider: 'claude', prompt: null, directory: null });
    return made;
  }

  it('resolves the terminal from the session and pauses it, killing nothing', async () => {
    const { sessions, terminals, ptys } = await running();
    terminals.observe(SESSION_1, 'awaiting-input');

    const outcome = sessions.pause(SESSION_1);

    expect(outcome).toEqual({ ok: true, ...SESSION_1, pause: 'paused' });
    expect(ptys.last?.kills).toBe(0);
    expect(terminals.holder(SESSION_1)?.pause).toBe('paused');
  });

  it('records a request against a session that is mid-turn, and says so', async () => {
    const { sessions, terminals } = await running();
    terminals.observe(SESSION_1, 'working');

    expect(sessions.pause(SESSION_1)).toEqual({ ok: true, ...SESSION_1, pause: 'requested' });
  });

  it('reports the pause on the hold, so the hub publishes it', async () => {
    const { sessions, terminals } = await running();
    terminals.observe(SESSION_1, 'idle');
    sessions.pause(SESSION_1);

    const report = await sessions.report(WORK);

    // The scan re-derives the status from disk, and `session-1` is recorded
    // as awaiting input there, which is a boundary: the pause holds.
    expect(report?.holding).toEqual([{ sessionId: 'session-1', stoppable: true, pause: 'paused' }]);
  });

  it('resumes a paused session, and answers with no pause left', async () => {
    const { sessions, terminals } = await running();
    terminals.observe(SESSION_1, 'idle');
    sessions.pause(SESSION_1);

    expect(sessions.resume(SESSION_1)).toEqual({ ok: true, ...SESSION_1, pause: 'none' });
    expect(terminals.holder(SESSION_1)?.pause).toBe('none');
  });

  it('refuses a pause and a resume for a session it is not running', () => {
    const { sessions } = machine();

    const refusal = { ok: false, code: 'refused', hold: null };
    expect(sessions.pause(SESSION_1)).toMatchObject(refusal);
    expect(sessions.resume(SESSION_1)).toMatchObject(refusal);
    expect(sessions.pause(SESSION_1)).toMatchObject({
      problem: 'this server is not running that session',
    });
  });
});

describe('the session controller reading one transcript', () => {
  it('answers with the tail of what the session did, oldest first', async () => {
    const { sessions } = machine();

    const read = await sessions.transcript({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      count: 2,
    });

    expect(read).toEqual({
      ok: true,
      activities: [
        { kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 },
        { kind: 'command', text: 'pnpm test', exitStatus: 1 },
      ],
      olderExist: true,
    });
  });

  it('refuses a store this server does not have mounted', async () => {
    const { sessions } = machine();

    const read = await sessions.transcript({
      storeId: storeIdSchema.parse('store-elsewhere'),
      sessionId: session('session-1'),
      provider: 'claude',
      count: 20,
    });

    expect(read).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this server does not have that store mounted',
    });
  });

  it('refuses a provider this build cannot drive', async () => {
    const { sessions } = machine({ noAdapter: true });

    const read = await sessions.transcript({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      count: 20,
    });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe('refused');
  });

  it('refuses, in the adapter’s own words, a session it cannot find', async () => {
    // The hub's view of a store is a scan or two old, so asking for a session
    // that has since been deleted is ordinary. The sentence comes from the
    // adapter, which is the only thing that knows what it looked for.
    const { sessions } = machine();

    const read = await sessions.transcript({
      storeId: WORK,
      sessionId: session('session-gone'),
      provider: 'claude',
      count: 20,
    });

    expect(read).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this store holds no transcript for that session',
    });
  });

  it('answers a refusal rather than a rejection when an adapter throws', async () => {
    // Once this is open source an adapter is somebody else's code, and a
    // transcript request that a third party can turn into an unhandled
    // rejection is a hub left waiting for an answer that never comes.
    const controller = createSessionController({
      stores: [STORE],
      providers: createProviderRegistry([
        createFakeProviderAdapter({ provider: 'claude', throwsOnTranscript: 'no' }),
      ]),
      terminals: createTerminalManager({
        supervisor: createPtySupervisor({
          pty: createFakePtyFactory(),
          clock,
          ids: { newId: () => 'run-0' },
          environment: {},
        }),
        clock,
        timers: createFakeTimers(),
      }),
      workingTree: createFakeWorkingTree(),
      homeDirectory: HOME,
      browse: createDirectoryBrowser({ roots: [], reader: DISK }),
      // Nothing to hand a launch: this controller is built to answer one
      // transcript read, which starts no process and asks nobody anything.
      approvals: null,
      signaller: createFakeProcessSignaller(),
      processes: createFakeProcessProbe(),
      timers: createFakeTimers(),
      clock,
      logger,
    });

    const read = await controller.transcript({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      count: 20,
    });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe('internal');
  });
});
