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
}

function machine(options: MachineOptions = {}): Machine {
  const files = createFakeProviderFiles({
    files: {
      '/volumes/work/claude/sessions/session-1.json': JSON.stringify({
        signal: 'awaiting-input',
        updatedAt: START - 1_000,
        cwd: '/volumes/work/project',
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
    });

    // No session id yet: the provider mints its own and the next scan finds it.
    expect(outcome).toMatchObject({ ok: true, sessionId: null });
    expect(ptys.opened[0]).toMatchObject({
      args: ['look at the failing test'],
      cwd: STORE.path,
    });
  });

  it('refuses a second start on a session it is already running, and names the hold', async () => {
    const { sessions, ptys } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
    });

    // The hub refuses this too, from its own state. This is the same rule where
    // the processes actually are, for the instruction that arrives anyway.
    const second = await sessions.start({
      storeId: WORK,
      sessionId: session('session-1'),
      provider: 'claude',
      prompt: null,
    });

    expect(second).toMatchObject({
      ok: false,
      code: 'refused',
      hold: { sessionId: 'session-1', stoppable: true },
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
    });

    const report = await sessions.report(WORK);

    expect(report?.sessions.map((one) => one.sessionId).sort()).toEqual([
      'session-1',
      'session-busy',
      'session-homeless',
    ]);
    expect(report?.holding).toEqual([{ sessionId: 'session-1', stoppable: true }]);
  });

  it('withholds the stop from a session that is mid-turn', async () => {
    const { sessions } = machine();
    await sessions.start({
      storeId: WORK,
      sessionId: session('session-busy'),
      provider: 'claude',
      prompt: null,
    });

    // The status is the adapter's, derived on the scan the report makes, and
    // it is what the hold is answered with. Nothing above the adapter decides
    // what mid-turn means for a provider.
    const report = await sessions.report(WORK);
    expect(report?.holding).toEqual([{ sessionId: 'session-busy', stoppable: false }]);
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
    });
    terminals.observe({ storeId: WORK, sessionId: session('session-1') }, 'working');

    const outcome = sessions.stop({ storeId: WORK, sessionId: session('session-1') });

    expect(outcome).toMatchObject({
      ok: false,
      code: 'refused',
      hold: { sessionId: 'session-1', stoppable: false },
    });
    expect(ptys.last?.kills).toBe(0);
  });
});
