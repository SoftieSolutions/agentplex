import {
  sessionRefSchema,
  startIdSchema,
  storeDescriptorSchema,
  type SessionId,
} from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionRef, SessionStatus } from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor, type PtySupervisor } from '@agentplex/pty';
import type { GrantId, Launch, LaunchPlan } from '@agentplex/providers';
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

/** Two hubs, each with a grant this server minted, and one start each. */
const A_GRANT = 'grant-one' as GrantId;
const ANOTHER_GRANT = 'grant-two' as GrantId;
const A_START = startIdSchema.parse('start-one');
const ANOTHER_START = startIdSchema.parse('start-two');

describe('createTerminalManager start tags', () => {
  it('holds a start against the terminal, not against whoever asked for it', () => {
    // The reason these live here at all. A connection comes and goes while the
    // agent it forked goes on running, so a name for that spawn that lived on
    // the connection would be lost exactly when the hub needs it most: after a
    // drop, with the provider still not having written a session id.
    const { manager } = harness();
    const terminalId = open(manager);

    manager.noteStart(terminalId, A_START, A_GRANT);

    expect(manager.starts(A_GRANT)).toEqual([{ startId: A_START, terminalId }]);
  });

  it("keeps two hubs' starts apart, because a start id means nothing to the other", () => {
    const { manager } = harness();
    const mine = open(manager);
    const theirs = open(manager);

    manager.noteStart(mine, A_START, A_GRANT);
    manager.noteStart(theirs, ANOTHER_START, ANOTHER_GRANT);

    expect(manager.starts(A_GRANT)).toEqual([{ startId: A_START, terminalId: mine }]);
    expect(manager.starts(ANOTHER_GRANT)).toEqual([{ startId: ANOTHER_START, terminalId: theirs }]);
  });

  it('says a grant that has started nothing has started nothing', () => {
    const { manager } = harness();

    expect(manager.starts(A_GRANT)).toEqual([]);
  });

  it('forgets a start when the terminal it named is evicted', () => {
    // A handle pointing at nothing is worse than no handle: it names a start
    // that is not running here, and the hub would wait on a terminal that no
    // longer exists.
    const { manager } = harness(1);
    const first = open(manager);
    manager.noteStart(first, A_START, A_GRANT);

    open(manager);

    expect(manager.terminal(first)).toBeUndefined();
    expect(manager.starts(A_GRANT)).toEqual([]);
  });

  it('forgets every start at shutdown', () => {
    const { manager } = harness();
    const terminalId = open(manager);
    manager.noteStart(terminalId, A_START, A_GRANT);

    manager.closeAll();

    expect(manager.starts(A_GRANT)).toEqual([]);
  });

  it('records nothing for a terminal that is already gone', () => {
    const { manager } = harness();
    const terminalId = open(manager);
    manager.closeAll();

    manager.noteStart(terminalId, A_START, A_GRANT);

    expect(manager.starts(A_GRANT)).toEqual([]);
  });

  it('keeps the start after the process exits, because the bytes are still here', () => {
    // A terminal outlives its process -- the session somebody most wants to
    // read is frequently the one that just stopped -- so the name for it
    // outlives the process too.
    const { manager, factory } = harness();
    const terminalId = open(manager);
    manager.noteStart(terminalId, A_START, A_GRANT);

    factory.ptys[0]?.close({ exitCode: 0, signal: null });

    expect(manager.starts(A_GRANT)).toEqual([{ startId: A_START, terminalId }]);
  });
});

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
  it('names its watchers and forwards output to each of them', () => {
    const { manager, factory } = harness();
    const terminalId = open(manager);
    const terminal = manager.terminal(terminalId);
    const seen: string[] = [];

    const detach = terminal?.watch('hub-a', (chunk) => seen.push(new TextDecoder().decode(chunk)));
    factory.last?.emit('hello');

    expect(terminal?.watchers).toEqual(['hub-a']);
    expect(terminal?.unwatchedSince).toBeNull();
    expect(seen).toEqual(['hello']);

    detach?.();
    factory.last?.emit('printed to nobody');

    expect(terminal?.watchers).toEqual([]);
    expect(seen).toEqual(['hello']);
  });

  /**
   * The question the count could not answer, and the reason this is a set: the
   * cap has to be able to tell that the terminal it is about to evict is the
   * only one a second connection is watching.
   */
  it('tells two connections apart on one terminal', () => {
    const { manager } = harness();
    const terminal = manager.terminal(open(manager));

    const first = terminal?.watch('hub-a', () => {});
    terminal?.watch('hub-b', () => {});
    expect(terminal?.watchers).toEqual(['hub-a', 'hub-b']);

    first?.();
    expect(terminal?.watchers).toEqual(['hub-b']);
    expect(terminal?.unwatchedSince).toBeNull();
  });

  /**
   * A socket that closes is a watcher that is gone, and it is not there to call
   * the detach it was handed. Without this the set only ever grows and a
   * terminal nobody can see becomes one the cap may never evict.
   */
  it('releases everything one connection was watching, everywhere', () => {
    const { manager, clock } = harness(4);
    const left = manager.terminal(open(manager));
    const right = manager.terminal(open(manager));
    left?.watch('hub-a', () => {});
    left?.watch('hub-b', () => {});
    right?.watch('hub-a', () => {});

    clock.advance(500);
    manager.release('hub-a');

    expect(left?.watchers).toEqual(['hub-b']);
    expect(left?.unwatchedSince).toBeNull();
    expect(right?.watchers).toEqual([]);
    expect(right?.unwatchedSince).toBe(clock.now());
  });

  it('releases a connection that was watching nothing without complaint', () => {
    const { manager } = harness();
    const terminal = manager.terminal(open(manager));
    terminal?.watch('hub-a', () => {});

    manager.release('hub-never-attached');

    expect(terminal?.watchers).toEqual(['hub-a']);
  });

  it('dates a terminal from when its last watcher left, not from when the first arrived', () => {
    const { manager, clock } = harness();
    const terminal = manager.terminal(open(manager));
    const first = terminal?.watch('a-hub', () => {});
    const second = terminal?.watch('a-hub', () => {});

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

    terminal?.watch('a-hub', () => {})?.();
    clock.advance(60 * 60 * 1000);

    expect(terminal?.run.exit).toBeNull();
    expect(factory.last?.kills).toBe(0);
    expect(manager.terminals).toHaveLength(1);
  });

  it('ignores a detach called twice rather than counting a watcher off twice', () => {
    const { manager } = harness();
    const terminal = manager.terminal(open(manager));
    const one = terminal?.watch('hub-a', () => {});
    terminal?.watch('hub-b', () => {});

    one?.();
    one?.();

    expect(terminal?.watchers).toEqual(['hub-b']);
  });

  /** One connection with two tabs on one terminal is still watching after one closes. */
  it('keeps a connection in the set until its last attachment goes', () => {
    const { manager } = harness();
    const terminal = manager.terminal(open(manager));
    const first = terminal?.watch('hub-a', () => {});
    const second = terminal?.watch('hub-a', () => {});

    first?.();
    expect(terminal?.watchers).toEqual(['hub-a']);

    second?.();
    expect(terminal?.watchers).toEqual([]);
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
    manager.terminal(newer)?.watch('a-hub', () => {})?.();
    clock.advance(3_000);
    manager.terminal(older)?.watch('a-hub', () => {})?.();

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
    manager.terminal(watched)?.watch('a-hub', () => {});

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
    manager.terminal(held)?.watch('a-hub', () => {});

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

describe('createTerminalManager pause', () => {
  /** A held, named session whose status the test picks. */
  function held(status: SessionStatus): Harness & { terminalId: string; session: SessionRef } {
    const made = harness();
    const session = sessionRef('session-a');
    const started = made.manager.resume(session, launch);
    if (!started.ok) throw new Error(started.problem);
    made.manager.observe(session, status);
    return { ...made, terminalId: started.terminal.terminalId, session };
  }

  it.each(['idle', 'awaiting-input', 'awaiting-permission'] as const)(
    'pauses at once a session whose derived status is %s: it is already at a boundary',
    (status) => {
      const { manager, terminalId, session, factory } = held(status);

      expect(manager.pause(terminalId)).toEqual({ ok: true, pause: 'paused' });
      expect(manager.terminal(terminalId)?.pause).toBe('paused');
      expect(manager.holder(session)?.pause).toBe('paused');
      // Never a kill. The process is exactly where it was.
      expect(factory.last?.kills).toBe(0);
    },
  );

  it.each(['working', 'unknown'] as const)(
    'records a request against a session that is %s, and promotes it at the next non-working status',
    (status) => {
      // Mid-turn is not a boundary, and a status nobody could derive may be
      // mid-turn for all anyone knows. Both wait for the turn to end.
      const { manager, terminalId, session } = held(status);

      expect(manager.pause(terminalId)).toEqual({ ok: true, pause: 'requested' });
      expect(manager.terminal(terminalId)?.pause).toBe('requested');

      manager.observe(session, 'working');
      expect(manager.terminal(terminalId)?.pause).toBe('requested');
      manager.observe(session, 'awaiting-input');
      expect(manager.terminal(terminalId)?.pause).toBe('paused');
    },
  );

  it('never promotes a request on an unknown status: not knowing is not a boundary', () => {
    const { manager, terminalId, session } = held('working');
    manager.pause(terminalId);

    manager.observe(session, 'unknown');

    expect(manager.terminal(terminalId)?.pause).toBe('requested');
  });

  it('re-arms a pause whose session is seen working again: paused -> requested -> paused', () => {
    // A paused session can still start a turn: an approval answered through
    // the gate lets the agent go on, and a pause taken on a stale status can
    // land mid-turn. Either way the boundary the pause claimed is gone, so the
    // pause drops back to a request and is taken again at the next boundary,
    // rather than a `paused` word standing over a session that is working.
    const { manager, terminalId, session } = held('idle');
    manager.pause(terminalId);
    expect(manager.terminal(terminalId)?.pause).toBe('paused');

    manager.observe(session, 'working');
    expect(manager.terminal(terminalId)?.pause).toBe('requested');
    expect(manager.holder(session)?.pause).toBe('requested');

    manager.observe(session, 'idle');
    expect(manager.terminal(terminalId)?.pause).toBe('paused');
    expect(manager.holder(session)?.pause).toBe('paused');
  });

  it.each(['idle', 'awaiting-input', 'awaiting-permission', 'unknown'] as const)(
    'leaves a paused session paused when %s is observed: only working re-arms it',
    (status) => {
      // `unknown` re-arms nothing, for the reason it promotes nothing: not
      // knowing what the session is doing is not evidence that it is working.
      const { manager, terminalId, session } = held('idle');
      manager.pause(terminalId);

      manager.observe(session, status);

      expect(manager.terminal(terminalId)?.pause).toBe('paused');
    },
  );

  it('answers a second pause with where the first one got to, and changes nothing', () => {
    const { manager, terminalId } = held('working');
    manager.pause(terminalId);

    expect(manager.pause(terminalId)).toEqual({ ok: true, pause: 'requested' });
  });

  it('clears a request and a pause alike on unpause', () => {
    const requested = held('working');
    requested.manager.pause(requested.terminalId);
    expect(requested.manager.unpause(requested.terminalId)).toEqual({ ok: true });
    expect(requested.manager.terminal(requested.terminalId)?.pause).toBe('none');

    const paused = held('idle');
    paused.manager.pause(paused.terminalId);
    expect(paused.manager.unpause(paused.terminalId)).toEqual({ ok: true });
    expect(paused.manager.holder(paused.session)?.pause).toBe('none');
  });

  it('takes an unpause on a session that was never paused, and changes nothing', () => {
    const { manager, terminalId } = held('idle');

    expect(manager.unpause(terminalId)).toEqual({ ok: true });
    expect(manager.terminal(terminalId)?.pause).toBe('none');
  });

  it('refuses a pause and an unpause on a run that has exited, in a sentence', () => {
    // `holder()` only finds live runs, so the controller can never reach this
    // by session; it is reachable by terminal id, which is why it is tested
    // here rather than one layer up.
    const { manager, terminalId, factory } = held('idle');
    factory.last?.close({ exitCode: 0, signal: null });

    const paused = manager.pause(terminalId);
    const unpaused = manager.unpause(terminalId);

    expect(paused).toEqual({
      ok: false,
      problem: `terminal ${terminalId} has exited: there is no turn left to pause`,
      holder: null,
    });
    expect(unpaused).toEqual({
      ok: false,
      problem: `terminal ${terminalId} has exited: there is nothing to resume`,
      holder: null,
    });
  });

  it('refuses a pause and an unpause for a terminal it does not have', () => {
    const { manager } = harness();

    expect(manager.pause('run-nothing')).toEqual({
      ok: false,
      problem: 'no terminal run-nothing',
      holder: null,
    });
    expect(manager.unpause('run-nothing')).toEqual({
      ok: false,
      problem: 'no terminal run-nothing',
      holder: null,
    });
  });

  it('still stops a paused terminal: a pause withholds input, never the stop', () => {
    const { manager, terminalId, factory } = held('idle');
    manager.pause(terminalId);

    expect(manager.stop(terminalId).ok).toBe(true);
    expect(factory.last?.kills).toBe(1);
  });

  it('names the pause on the holder and on the terminal view', () => {
    const { manager, terminalId, session } = held('idle');

    expect(manager.terminal(terminalId)?.pause).toBe('none');
    expect(manager.holder(session)?.pause).toBe('none');
    manager.pause(terminalId);
    expect(manager.terminal(terminalId)?.pause).toBe('paused');
    expect(manager.holder(session)).toMatchObject({ pause: 'paused', stoppable: true });
  });
});

describe('createTerminalManager shutdown', () => {
  it('closes every terminal it is holding, which is the only thing that does', () => {
    const { manager, factory } = harness();
    const watched = open(manager);
    manager.terminal(watched)?.watch('a-hub', () => {});
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
      pause: 'none',
    });
    expect(manager.holder(sessionRef('session-b'))).toBeUndefined();
  });
});

describe('createTerminalManager seal', () => {
  it('refuses a spawn and a resume once it is sealed, and starts nothing', () => {
    const { manager, factory } = harness();

    manager.seal();

    const spawned = manager.spawn(STORE, launch);
    const resumed = manager.resume(sessionRef('session-a'), launch);
    expect(spawned).toEqual({
      ok: false,
      problem: 'this server is shutting down',
      holder: null,
    });
    expect(resumed.ok).toBe(false);
    expect(factory.opened).toHaveLength(0);
  });

  it('leaves every live terminal alone, because that is the whole point of a drain', () => {
    const { manager, factory } = harness();
    const running = open(manager);

    manager.seal();

    expect(manager.sealed).toBe(true);
    expect(manager.terminal(running)).toBeDefined();
    expect(factory.ptys[0]?.kills).toBe(0);
  });

  it('evicts nothing to make room for a start it is going to refuse anyway', () => {
    // The cap is reached and every terminal is closable, so an unsealed manager
    // would close the longest-unwatched one here. Doing that on the way out
    // would cost a session for a start that was never going to happen.
    const { manager, factory } = harness(1);
    open(manager);

    manager.seal();
    const refused = manager.spawn(STORE, launch);

    expect(refused.ok).toBe(false);
    expect(factory.ptys[0]?.kills).toBe(0);
    expect(manager.terminals).toHaveLength(1);
  });

  it('is one-way and idempotent: nothing unseals a manager', () => {
    const { manager } = harness();

    expect(manager.sealed).toBe(false);
    manager.seal();
    manager.seal();

    expect(manager.sealed).toBe(true);
    expect(manager.spawn(STORE, launch).ok).toBe(false);
  });
});
