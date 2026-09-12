import { sessionRefSchema, storeDescriptorSchema, type StoreId } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import type { Clock, Timers } from '@agentplex/node-shared';
import { createLogger } from '@agentplex/node-shared';
import type { Launch, LaunchPlan } from '@agentplex/providers';
import { createDrain, drainingSessions, DRAIN_POLL_MS } from './drain.js';
import { createFakeTerminals, type FakeTerminals } from './fake-terminals.js';

/**
 * The drain, against the real terminal manager over the fake pty.
 *
 * Nothing here is a stand-in for the rule being tested. The manager is the
 * shipped one, so `stoppable` is the shipped predicate and a refusal here is
 * the same refusal a person clicking stop would get; only the pty is fake,
 * because a unit test cannot fork one, and only the status comes from the test,
 * because that is the adapter's answer and the adapter is not what is under
 * test. What the drain has to get right is what it does with a terminal that is
 * working, one that stops working while it waits, and one that never does.
 */

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const OTHER_STORE = storeDescriptorSchema.parse({ storeId: 'store-b', path: '/volumes/codex' });

const PLAN: LaunchPlan = {
  command: 'claude',
  args: [],
  cwd: '/Users/dev/Code/agentplex',
  env: {},
  scrubEnvPrefixes: ['CLAUDE'],
};

const launch: Launch = { ok: true, plan: PLAN };

const session = (storeId: StoreId, id: string) =>
  sessionRefSchema.parse({ storeId, sessionId: id });

const START = 1_756_000_000_000;

/** A clock the test winds, because every bound in here is about elapsed time. */
function windableClock(): Clock & { advance(ms: number): void } {
  let now = START;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

/**
 * Timers that fire the moment they are asked to, and remember what they were
 * asked for.
 *
 * Waiting is not what these tests are about -- the clock is, and the test winds
 * that itself. Firing at once keeps every case below deterministic and free of
 * real time, while `delays` still proves the drain asked for the poll interval
 * rather than spinning.
 */
function instantTimers(): Timers & { readonly delays: readonly number[] } {
  const delays: number[] = [];
  return {
    schedule(afterMs: number, fire: () => void): () => void {
      delays.push(afterMs);
      fire();
      return () => undefined;
    },
    get delays() {
      return delays;
    },
  };
}

const logger = createLogger('error', () => {});

interface Harness {
  readonly fake: FakeTerminals;
  readonly clock: Clock & { advance(ms: number): void };
  readonly timers: Timers & { readonly delays: readonly number[] };
  /** Every store the drain asked about, in order, across every pass. */
  readonly asked: StoreId[];
}

function harness(): Harness {
  return {
    fake: createFakeTerminals(),
    clock: windableClock(),
    timers: instantTimers(),
    asked: [],
  };
}

/**
 * The drain, with an `observe` that stands in for one scan of a store.
 *
 * `onObserve` is where a test says what the provider would have reported by
 * now, and winding the clock inside it is what makes a scan cost time: the real
 * seam reads a store off disk, and the budget is spent by scans rather than by
 * a timer the test would have to fire.
 */
function drainOf(
  { fake, clock, timers, asked }: Harness,
  budgetMs: number,
  onObserve: (storeId: StoreId, scan: number) => void = () => undefined,
) {
  let scans = 0;
  return createDrain({
    terminals: fake.terminals,
    observe: async (storeId: StoreId) => {
      asked.push(storeId);
      scans += 1;
      clock.advance(DRAIN_POLL_MS);
      onObserve(storeId, scans);
      return Promise.resolve();
    },
    timers,
    clock,
    logger,
    budgetMs,
  });
}

describe('the drain', () => {
  it('closes a session that is already at a boundary, without waiting for it', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    const opened = world.fake.terminals.resume(ref, launch);
    expect(opened.ok).toBe(true);
    world.fake.terminals.observe(ref, 'awaiting-input');

    const report = await drainOf(world, 15_000).run();

    expect(report.end).toBe('drained');
    expect(report.drained).toBe(1);
    expect(report.killed).toBe(0);
    expect(world.fake.factory.ptys[0]?.kills).toBe(1);
    // One pass. Nothing was waited for, so nothing was scheduled.
    expect(world.timers.delays).toEqual([]);
  });

  it('waits for a session that is working, and closes it at the boundary', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    world.fake.terminals.resume(ref, launch);
    world.fake.terminals.observe(ref, 'working');

    // The provider finishes its turn between the second scan and the third.
    const report = await drainOf(world, 15_000, (_storeId, scan) => {
      if (scan === 3) world.fake.terminals.observe(ref, 'awaiting-input');
    }).run();

    expect(report.end).toBe('drained');
    expect(report.drained).toBe(1);
    expect(report.killed).toBe(0);
    // Two waits between three scans, each for the poll interval.
    expect(world.timers.delays).toEqual([DRAIN_POLL_MS, DRAIN_POLL_MS]);
  });

  it('gives up when the budget runs out, and says how many it did not release', async () => {
    const world = harness();
    const stuck = session(STORE.storeId, 'session-1');
    const done = session(STORE.storeId, 'session-2');
    world.fake.terminals.resume(stuck, launch);
    world.fake.terminals.resume(done, launch);
    world.fake.terminals.observe(stuck, 'working');
    world.fake.terminals.observe(done, 'awaiting-input');

    // Two passes at the poll interval, and then the budget is gone.
    const report = await drainOf(world, 2 * DRAIN_POLL_MS).run();

    expect(report.end).toBe('expired');
    expect(report.drained).toBe(1);
    expect(report.killed).toBe(1);
    // The one at a boundary was closed; the one mid-turn is still alive, and
    // killing it is the caller's -- a drain decides when to stop waiting and
    // never what to do afterwards.
    expect(world.fake.factory.ptys[0]?.kills).toBe(0);
    expect(world.fake.factory.ptys[1]?.kills).toBe(1);
  });

  it('never waits past the budget, even when the budget is shorter than a poll', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    world.fake.terminals.resume(ref, launch);
    world.fake.terminals.observe(ref, 'working');

    const report = await drainOf(world, 2 * DRAIN_POLL_MS + 100).run();

    expect(report.end).toBe('expired');
    // Two whole polls, and then the 100ms that were left rather than a third
    // poll that would overrun what the unit allows.
    expect(world.timers.delays).toEqual([DRAIN_POLL_MS, 100]);
  });

  it('does one pass and no waiting when there is no budget at all', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    world.fake.terminals.resume(ref, launch);
    world.fake.terminals.observe(ref, 'working');

    const report = await drainOf(world, 0).run();

    expect(report.end).toBe('expired');
    expect(report.killed).toBe(1);
    expect(world.asked).toEqual([STORE.storeId]);
  });

  it('stops waiting when it is told to, which is what a second signal means', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    world.fake.terminals.resume(ref, launch);
    world.fake.terminals.observe(ref, 'working');

    const drain = drainOf(world, 60_000, (_storeId, scan) => {
      if (scan === 2) drain.stopWaiting();
    });
    const report = await drain.run();

    expect(report.end).toBe('abandoned');
    expect(report.killed).toBe(1);
    // Two scans and one wait: the budget would have bought a hundred more.
    expect(world.asked.length).toBe(2);
  });

  it('asks only the stores that still hold something', async () => {
    const world = harness();
    const here = session(STORE.storeId, 'session-1');
    const there = session(OTHER_STORE.storeId, 'session-2');
    world.fake.terminals.resume(here, launch);
    world.fake.terminals.resume(there, launch);
    world.fake.terminals.observe(here, 'awaiting-input');
    world.fake.terminals.observe(there, 'working');

    // The third scan is the second pass over the second store: the first pass
    // scanned both.
    await drainOf(world, 4 * DRAIN_POLL_MS, (_storeId, scan) => {
      if (scan === 3) world.fake.terminals.observe(there, 'idle');
    }).run();

    // The first pass asks both. Once the first store's only terminal is closed
    // it is not scanned again, because a shutting-down server re-reading a
    // volume it has nothing running in is work nobody is waiting for.
    expect(world.asked).toEqual([STORE.storeId, OTHER_STORE.storeId, OTHER_STORE.storeId]);
  });

  it('lets a store it cannot read cost its own sessions and not the drain', async () => {
    const world = harness();
    const readable = session(STORE.storeId, 'session-1');
    const unreadable = session(OTHER_STORE.storeId, 'session-2');
    world.fake.terminals.resume(readable, launch);
    world.fake.terminals.resume(unreadable, launch);
    world.fake.terminals.observe(readable, 'awaiting-input');
    world.fake.terminals.observe(unreadable, 'working');

    const drain = createDrain({
      terminals: world.fake.terminals,
      observe: (storeId: StoreId) =>
        storeId === OTHER_STORE.storeId
          ? Promise.reject(new Error('the volume is gone'))
          : Promise.resolve(),
      timers: world.timers,
      clock: world.clock,
      logger,
      budgetMs: 0,
    });
    const report = await drain.run();

    expect(report.drained).toBe(1);
    expect(report.killed).toBe(1);
  });

  it('settles a terminal whose process has already ended, without stopping it', async () => {
    const world = harness();
    const ref = session(STORE.storeId, 'session-1');
    world.fake.terminals.resume(ref, launch);
    world.fake.terminals.observe(ref, 'working');
    world.fake.factory.ptys[0]?.close({ exitCode: 0, signal: null });

    const report = await drainOf(world, 15_000).run();

    expect(report.end).toBe('drained');
    expect(report.drained).toBe(1);
    expect(world.fake.factory.ptys[0]?.kills).toBe(0);
  });

  it('reports nothing to wait for on a server holding no terminals', async () => {
    const world = harness();

    const report = await drainOf(world, 15_000).run();

    expect(report).toMatchObject({ end: 'drained', drained: 0, killed: 0 });
    expect(world.asked).toEqual([]);
  });
});

describe('the sessions a drain names to the hub', () => {
  it('names every live session it holds', () => {
    const world = harness();
    world.fake.terminals.resume(session(STORE.storeId, 'session-1'), launch);
    world.fake.terminals.resume(session(OTHER_STORE.storeId, 'session-2'), launch);

    expect(drainingSessions(world.fake.terminals)).toEqual([
      { storeId: STORE.storeId, sessionId: 'session-1' },
      { storeId: OTHER_STORE.storeId, sessionId: 'session-2' },
    ]);
  });

  it('leaves out a spawn the provider has not named yet rather than guessing one', () => {
    const world = harness();
    world.fake.terminals.spawn(STORE, launch);
    world.fake.terminals.resume(session(STORE.storeId, 'session-1'), launch);

    // The unnamed one is running and is about to be closed, and there is no
    // honest way to say which session it is. A guess would have the hub mark
    // the wrong row as closing.
    expect(drainingSessions(world.fake.terminals)).toEqual([
      { storeId: STORE.storeId, sessionId: 'session-1' },
    ]);
  });

  it('leaves out a terminal whose process has already ended', () => {
    const world = harness();
    world.fake.terminals.resume(session(STORE.storeId, 'session-1'), launch);
    world.fake.factory.ptys[0]?.close({ exitCode: 0, signal: null });

    expect(drainingSessions(world.fake.terminals)).toEqual([]);
  });
});
