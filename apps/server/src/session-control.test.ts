import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type StoreDescriptor,
  type UncommittedDiff,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { createFakeProviderAdapter, createFakeProviderFiles } from '@agentplex/providers/testing';
import { createProviderRegistry } from '@agentplex/providers';
import { createDirectoryBrowser } from './directory-browse.js';
import { createFakeDirectoryReader } from './fake-directory-reader.js';
import { createFakeWorkingTree, type FakeWorkingTree } from './fake-working-tree.js';
import { createSessionController, type SessionController } from './session-control.js';
import { createTerminalManager, type TerminalManager } from './terminal-manager.js';

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
  const files = createFakeProviderFiles({
    files: {
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
    },
  });

  const ptys = createFakePtyFactory();
  const terminals = createTerminalManager({
    supervisor: createPtySupervisor({
      pty: ptys,
      clock,
      ids: { newId: () => `run-${ptys.ptys.length}` },
      environment: {},
    }),
    clock,
  });

  const workingTree = options.workingTree ?? createFakeWorkingTree();

  return {
    ptys,
    terminals,
    workingTree,
    sessions: createSessionController({
      stores: [STORE],
      providers: createProviderRegistry(
        options.noAdapter === true
          ? []
          : [createFakeProviderAdapter({ provider: 'claude', files })],
      ),
      terminals,
      workingTree,
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
      clock,
      logger,
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

  it('spawns in the store this server resolved, with the prompt as one argument', async () => {
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
      cwd: STORE.path,
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
      }),
      workingTree: createFakeWorkingTree(),
      browse: createDirectoryBrowser({ roots: [], reader: DISK }),
      // Nothing to hand a launch: this controller is built to answer one
      // transcript read, which starts no process and asks nobody anything.
      approvals: null,
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
