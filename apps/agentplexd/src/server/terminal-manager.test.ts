import { sessionRefSchema, storeDescriptorSchema, type SessionId } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { IdGenerator } from '../shared/ids.js';
import { createFakePtyFactory, type FakePtyFactory } from './fake-pty.js';
import type { Launch, LaunchPlan } from './providers/provider-adapter.js';
import { createPtySupervisor, type PtySupervisor } from './pty-supervisor.js';
import { createTerminalManager, type TerminalManager } from './terminal-manager.js';

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });

const sessionRef = (sessionId: string) =>
  sessionRefSchema.parse({ storeId: STORE.storeId, sessionId });

const sessionId = (id: string): SessionId => sessionRef(id).sessionId;

const PLAN: LaunchPlan = {
  command: 'claude',
  args: [],
  cwd: '/Users/dev/Code/agentplex',
  env: {},
  scrubEnvPrefixes: ['CLAUDE'],
};

const launch: Launch = { ok: true, plan: PLAN };

const START = 1_756_000_000_000;

/** A clock a test winds by hand, because every eviction rule here is about time. */
function windableClock(start = START): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function countingIds(): IdGenerator {
  let next = 0;
  return { newId: () => `run-${(next += 1)}` };
}

interface Harness {
  readonly manager: TerminalManager;
  readonly supervisor: PtySupervisor;
  readonly factory: FakePtyFactory;
  readonly clock: Clock & { advance(ms: number): void };
}

function harness(cap?: number): Harness {
  const factory = createFakePtyFactory();
  const clock = windableClock();
  const supervisor = createPtySupervisor({
    pty: factory,
    clock,
    ids: countingIds(),
    environment: {},
  });
  // Omitted rather than passed as undefined: the workspace is on
  // `exactOptionalPropertyTypes`, so only an absent property takes the default.
  const manager = createTerminalManager({
    supervisor,
    clock,
    ...(cap === undefined ? {} : { cap }),
  });
  return { manager, supervisor, factory, clock };
}

/** Opens a terminal or fails the test: every eviction test needs several. */
function open(manager: TerminalManager): string {
  const opened = manager.spawn(STORE, launch);
  if (!opened.ok) throw new Error(`the spawn should have opened: ${opened.problem}`);
  return opened.terminal.terminalId;
}

describe('createTerminalManager one live process per session', () => {
  it('refuses a resume for a session that already has a live terminal, and names the holder', () => {
    const { manager } = harness();
    const session = sessionRef('session-a');
    const first = manager.resume(session, launch);

    const second = manager.resume(session, launch);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // Naming the holder is the whole point: "already running" with nothing to
    // point at leaves the user with a session they can neither open nor stop.
    expect(!second.ok && second.holder).toMatchObject({
      terminalId: first.ok ? first.terminal.terminalId : '',
      sessionId: 'session-a',
      storeId: 'store-a',
      pid: first.ok ? first.terminal.run.pid : 0,
    });
  });

  it('opens nothing when it refuses, rather than starting a second agent on the store', () => {
    const { manager, factory } = harness();
    const session = sessionRef('session-a');
    manager.resume(session, launch);

    manager.resume(session, launch);

    expect(factory.opened).toHaveLength(1);
  });

  it('lets a session be resumed once its holder has exited', () => {
    // The invariant is one live process, not one terminal ever. A holder that
    // exited holds nothing; refusing on its account would strand the session
    // until somebody found a terminal nobody is looking at.
    const { manager, factory } = harness();
    const session = sessionRef('session-a');
    manager.resume(session, launch);
    factory.last?.close({ exitCode: 0, signal: null });

    const again = manager.resume(session, launch);

    expect(again.ok).toBe(true);
  });

  it('passes an adapter refusal through untouched, with no holder to name', () => {
    const { manager, factory } = harness();

    const refused = manager.spawn(STORE, { ok: false, problem: 'no working directory' });

    expect(refused).toEqual({ ok: false, problem: 'no working directory', holder: null });
    expect(factory.opened).toEqual([]);
  });

  it('holds a spawn under no session until discovery says which one it minted', () => {
    // A spawn cannot name a session: the provider mints the id and writes it,
    // and agentplex naming it up front would mean `--session-id`.
    const { manager } = harness();
    const terminalId = open(manager);

    expect(manager.terminal(terminalId)?.session).toBeNull();
    expect(manager.isRunning(sessionRef('session-a'))).toBe(false);

    const bound = manager.bind(terminalId, sessionId('session-a'));

    expect(bound.ok).toBe(true);
    expect(manager.terminal(terminalId)?.session).toEqual({
      storeId: 'store-a',
      sessionId: 'session-a',
    });
    expect(manager.isRunning(sessionRef('session-a'))).toBe(true);
  });

  it('refuses to bind a session that another live terminal already holds', () => {
    const { manager } = harness();
    const holder = manager.resume(sessionRef('session-a'), launch);
    const stray = open(manager);

    const bound = manager.bind(stray, sessionId('session-a'));

    expect(bound.ok).toBe(false);
    expect(!bound.ok && bound.holder?.terminalId).toBe(holder.ok ? holder.terminal.terminalId : '');
    // Refused, not killed: the process is already running and something has to
    // decide what happens to it. The terminal keeps its own identity meanwhile.
    expect(manager.terminal(stray)?.session).toBeNull();
  });

  it('answers liveness for bound live terminals only', () => {
    const { manager, factory } = harness();
    manager.resume(sessionRef('session-a'), launch);

    expect(manager.isRunning(sessionRef('session-a'))).toBe(true);
    expect(manager.isRunning(sessionRef('session-b'))).toBe(false);

    factory.last?.close({ exitCode: 0, signal: null });

    expect(manager.isRunning(sessionRef('session-a'))).toBe(false);
  });
});

describe('createTerminalManager watch accounting', () => {
  it('counts watchers and forwards output to each of them', () => {
    const { manager, factory } = harness();
    const terminalId = open(manager);
    const terminal = manager.terminal(terminalId);
    const seen: string[] = [];

    const detach = terminal?.watch((chunk) => seen.push(new TextDecoder().decode(chunk)));
    factory.last?.emit('hello');

    expect(terminal?.watchers).toBe(1);
    expect(terminal?.unwatchedSince).toBeNull();
    expect(seen).toEqual(['hello']);

    detach?.();
    factory.last?.emit('printed to nobody');

    expect(terminal?.watchers).toBe(0);
    expect(seen).toEqual(['hello']);
  });

  it('dates a terminal from when its last watcher left, not from when the first arrived', () => {
    const { manager, clock } = harness();
    const terminal = manager.terminal(open(manager));
    const first = terminal?.watch(() => {});
    const second = terminal?.watch(() => {});

    clock.advance(5_000);
    first?.();

    // Still watched: the second tab is open, and a tab is a watcher.
    expect(terminal?.unwatchedSince).toBeNull();

    second?.();

    expect(terminal?.unwatchedSince).toBe(START + 5_000);
  });

  it('counts a terminal nobody has watched yet as unwatched since it opened', () => {
    // Otherwise a terminal opened by an API call that no tab ever attached to
    // would be the one thing eviction could never reach.
    const { manager } = harness();

    expect(manager.terminal(open(manager))?.unwatchedSince).toBe(START);
  });

  it('keeps a terminal alive when its last watcher leaves', () => {
    // Sessions outlive tabs and sockets. Closing on detach is the failure this
    // whole design exists to avoid: the agent goes on working either way, and
    // killing it because a laptop lid closed loses the work in flight.
    const { manager, factory, clock } = harness();
    const terminal = manager.terminal(open(manager));

    terminal?.watch(() => {})?.();
    clock.advance(60 * 60 * 1000);

    expect(terminal?.run.exit).toBeNull();
    expect(factory.last?.kills).toBe(0);
    expect(manager.terminals).toHaveLength(1);
  });

  it('ignores a detach called twice rather than counting a watcher off twice', () => {
    const { manager } = harness();
    const terminal = manager.terminal(open(manager));
    const one = terminal?.watch(() => {});
    terminal?.watch(() => {});

    one?.();
    one?.();

    expect(terminal?.watchers).toBe(1);
  });
});

describe('createTerminalManager cap and eviction', () => {
  it('evicts the terminal whose last watcher left longest ago', () => {
    // Opened first, watched last: the two orders are deliberately opposite, so
    // that an eviction picking the oldest terminal rather than the one nobody
    // has looked at for longest fails this.
    const { manager, factory, clock } = harness(2);
    const older = open(manager);
    clock.advance(1_000);
    const newer = open(manager);

    clock.advance(1_000);
    manager.terminal(newer)?.watch(() => {})?.();
    clock.advance(3_000);
    manager.terminal(older)?.watch(() => {})?.();

    const third = open(manager);

    expect(manager.terminal(newer)).toBeUndefined();
    expect(factory.ptys[1]?.kills).toBe(1);
    expect(manager.terminals.map((terminal) => terminal.terminalId)).toEqual([older, third]);
  });

  it('will not evict a terminal somebody is watching', () => {
    const { manager, factory, clock } = harness(2);
    const watched = open(manager);
    clock.advance(1_000);
    const idle = open(manager);
    manager.terminal(watched)?.watch(() => {});

    open(manager);

    // The oldest by every other measure, and still not the one that goes.
    expect(manager.terminal(watched)).toBeDefined();
    expect(manager.terminal(idle)).toBeUndefined();
    expect(factory.ptys[0]?.kills).toBe(0);
  });

  it('prefers a terminal that has already exited, which costs nothing to close', () => {
    const { manager, factory, clock } = harness(2);
    const oldest = open(manager);
    clock.advance(10_000);
    const exited = open(manager);
    factory.ptys[1]?.close({ exitCode: 0, signal: null });

    open(manager);

    expect(manager.terminal(exited)).toBeUndefined();
    expect(manager.terminal(oldest)).toBeDefined();
    // Nothing was signalled: the process was already gone.
    expect(factory.ptys[1]?.kills).toBe(0);
  });

  it('refuses to open when the cap is reached and every terminal is watched', () => {
    const { manager, factory } = harness(1);
    const held = open(manager);
    manager.terminal(held)?.watch(() => {});

    const refused = manager.spawn(STORE, launch);

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problem).toContain('1');
    expect(!refused.ok && refused.holder).toBeNull();
    expect(factory.opened).toHaveLength(1);
  });

  it('evicts nothing for a launch the adapter already refused', () => {
    const { manager } = harness(1);
    const only = open(manager);

    manager.spawn(STORE, { ok: false, problem: 'no working directory' });

    expect(manager.terminal(only)).toBeDefined();
  });

  it('drops an evicted run from the supervisor, so shutdown does not count it', () => {
    const { manager, supervisor } = harness(1);
    open(manager);

    open(manager);

    expect(supervisor.runs).toHaveLength(1);
  });
});

describe('createTerminalManager stop', () => {
  it('kills the process and keeps the terminal readable', () => {
    // The transcript is on disk and the scrollback is in memory; a stop is
    // about the process, and the thing a user reads next is what it last said.
    const { manager, factory } = harness();
    const terminalId = open(manager);
    factory.last?.emit('the last thing it said');

    const stopped = manager.stop(terminalId);

    expect(stopped.ok).toBe(true);
    expect(factory.last?.kills).toBe(1);
    expect(manager.terminal(terminalId)).toBeDefined();
  });

  it('refuses a stop against a busy holder, and names it', () => {
    const { manager, factory } = harness();
    const session = sessionRef('session-a');
    const started = manager.resume(session, launch);
    manager.observe(session, 'working');

    const stopped = manager.stop(started.ok ? started.terminal.terminalId : '');

    expect(stopped.ok).toBe(false);
    expect(!stopped.ok && stopped.holder?.stoppable).toBe(false);
    expect(factory.last?.kills).toBe(0);
  });

  it('offers a stop to a holder that is waiting on a person', () => {
    const { manager } = harness();
    const session = sessionRef('session-a');
    const started = manager.resume(session, launch);
    manager.observe(session, 'awaiting-permission');

    expect(started.ok && started.terminal.stoppable).toBe(true);
    expect(manager.stop(started.ok ? started.terminal.terminalId : '').ok).toBe(true);
  });

  it('offers a stop to a holder nobody could read a status for', () => {
    // Unknown is not busy. A session whose transcript cannot be parsed would
    // otherwise be unkillable, and the only way out would be an eviction
    // nobody asked for.
    const { manager } = harness();
    const terminalId = open(manager);

    expect(manager.terminal(terminalId)?.status).toBe('unknown');
    expect(manager.stop(terminalId).ok).toBe(true);
  });

  it('refuses a stop for a terminal it does not have', () => {
    const { manager } = harness();

    const stopped = manager.stop('run-nothing');

    expect(stopped.ok).toBe(false);
    expect(!stopped.ok && stopped.holder).toBeNull();
  });

  it('ignores an observation about a session it is not holding', () => {
    const { manager } = harness();
    const terminalId = open(manager);

    manager.observe(sessionRef('session-elsewhere'), 'working');

    expect(manager.terminal(terminalId)?.status).toBe('unknown');
  });
});

describe('createTerminalManager shutdown', () => {
  it('closes every terminal it is holding, which is the only thing that does', () => {
    const { manager, factory } = harness();
    const watched = open(manager);
    manager.terminal(watched)?.watch(() => {});
    open(manager);

    manager.closeAll();

    expect(factory.ptys.map((pty) => pty.kills)).toEqual([1, 1]);
    expect(manager.terminals).toEqual([]);
  });

  it('names a holder for a session the hub asks about', () => {
    const { manager } = harness();
    const session = sessionRef('session-a');
    manager.resume(session, launch);

    expect(manager.holder(session)).toMatchObject({
      sessionId: 'session-a',
      storeId: 'store-a',
      watchers: 0,
      status: 'unknown',
      stoppable: true,
    });
    expect(manager.holder(sessionRef('session-b'))).toBeUndefined();
  });
});
