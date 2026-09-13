import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import type { ServerToHubFrame, StoreDescriptor, StoreId } from '@agentplex/protocol';
import type { GrantId } from '@agentplex/providers';
import { createHubAudience, type HubAudience, type HubMember } from './hub-audience.js';
import {
  createFakeSessionController,
  type FakeSessionController,
} from './fake-session-controller.js';
import { createFakeStoreWatcher, type FakeStoreWatcher } from './fake-store-watcher.js';
import type { SessionController, StoreReport } from './session-control.js';
import {
  STORE_WATCH_BACKOFF_MS,
  STORE_WATCH_DEBOUNCE_MS,
  watchStores,
  type StoreWatchers,
} from './store-watch.js';

/**
 * The watcher, against the audience that ships and a filesystem a test fires by
 * hand.
 *
 * The real `createHubAudience` and not a fake of it, because half of what is
 * under test is a claim about it: a change produces one scan of the store and
 * one report per connected hub, which is the audience's fan-out and not
 * something this file may re-implement to assert. What is faked is the disk,
 * which is the one thing a test cannot make fire on demand.
 */

const STORE: StoreDescriptor = { storeId: 'store-a' as StoreId, path: '/volumes/claude' };
const OTHER: StoreDescriptor = { storeId: 'store-b' as StoreId, path: '/volumes/codex' };

function report(store: StoreDescriptor): StoreReport {
  return { storeId: store.storeId, sessions: [], holding: [] };
}

function member(connectionId: string, grantId: string) {
  const sent: ServerToHubFrame[] = [];
  const value: HubMember = {
    connectionId,
    grantId: grantId as GrantId,
    send: (frame) => void sent.push(frame),
    takeStartTags: () => [],
    close: () => {},
  };
  return { member: value, sent };
}

interface World {
  readonly watchers: StoreWatchers;
  readonly watcher: FakeStoreWatcher;
  readonly timers: FakeTimers;
  readonly audience: HubAudience;
  readonly sessions: FakeSessionController;
  readonly records: readonly LogRecord[];
  /** Joins a hub and gives back what it was sent. */
  join(connectionId: string): { readonly sent: readonly ServerToHubFrame[] };
}

interface WorldOptions {
  readonly stores?: readonly StoreDescriptor[];
  readonly refuse?: readonly string[];
  /** A controller other than the ordinary one: a scan that can be held open. */
  readonly controller?: SessionController;
}

function start(options: WorldOptions = {}): World {
  const stores = options.stores ?? [STORE];
  const sessions = createFakeSessionController({ reports: stores.map(report) });
  const records: LogRecord[] = [];
  const logger = createLogger('debug', (record) => records.push(record));
  const audience = createHubAudience({ sessions: options.controller ?? sessions, logger });
  const watcher = createFakeStoreWatcher({ ...(options.refuse ? { refuse: options.refuse } : {}) });
  const timers = createFakeTimers();

  return {
    watchers: watchStores({ stores, watcher, audience, timers, logger }),
    watcher,
    timers,
    audience,
    sessions,
    records,
    join(connectionId: string) {
      const one = member(connectionId, `grant-${connectionId}`);
      audience.join(one.member);
      return one;
    },
  };
}

/** Lets a report that is already running reach the hubs it is going to. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

/** Fires the window and lets the report that it started settle. */
async function settle(world: World): Promise<void> {
  world.timers.fireAll();
  await flush();
}

function warnings(records: readonly LogRecord[]): readonly LogRecord[] {
  return records.filter((record) => record.level === 'warn');
}

describe('watching a store', () => {
  it('reports a change to every connected hub, once, after the window', async () => {
    const world = start();
    const first = world.join('connection-1');
    const second = world.join('connection-2');

    world.watcher.change(STORE.path);
    // Nothing yet: the window is what turns a write into a report, and a
    // report sent on the event itself would be one per write of a transcript.
    expect(first.sent).toHaveLength(0);

    await settle(world);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatchObject({ type: 'store-report', storeId: STORE.storeId });
    expect(second.sent).toEqual(first.sent);
    // One scan for both of them, which is the audience's promise and the whole
    // reason this reports through it rather than per connection.
    expect(world.sessions.scans).toEqual([STORE.storeId]);
  });

  it('waits exactly the window it names', () => {
    const world = start();
    world.join('connection-1');

    world.watcher.change(STORE.path);

    expect(world.timers.delays).toEqual([STORE_WATCH_DEBOUNCE_MS]);
  });

  it('turns a burst into one report', async () => {
    const world = start();
    const only = world.join('connection-1');

    // A transcript being written is tens of these. The window is armed by the
    // first and not restarted by the rest, so a store that is being written to
    // continuously is still reported rather than reported when it goes quiet.
    for (let event = 0; event < 20; event += 1) world.watcher.change(STORE.path);
    expect(world.timers.pending).toBe(1);

    await settle(world);

    expect(only.sent).toHaveLength(1);
    expect(world.sessions.scans).toEqual([STORE.storeId]);
  });

  it('scans nothing while no hub is connected', async () => {
    const world = start();

    world.watcher.change(STORE.path);
    await settle(world);

    // A laptop running an agent with no hub dialled in. The scan would go
    // nowhere, and the hub that connects next is sent this store on its
    // handshake.
    expect(world.sessions.scans).toEqual([]);
  });

  it('reports the store that changed and no other', async () => {
    const world = start({ stores: [STORE, OTHER] });
    const only = world.join('connection-1');

    world.watcher.change(OTHER.path);
    await settle(world);

    expect(world.sessions.scans).toEqual([OTHER.storeId]);
    expect(only.sent).toHaveLength(1);
    expect(only.sent[0]).toMatchObject({ storeId: OTHER.storeId });
  });

  it('stops watching, and cancels a report that had not gone out', async () => {
    const world = start();
    world.join('connection-1');
    world.watcher.change(STORE.path);

    world.watchers.stop();
    await settle(world);

    // A shutdown's own polling is the only thing that should be reporting by
    // then: a report from here would scan a store the drain is already
    // scanning, for hubs that are about to be told this server is going away.
    expect(world.sessions.scans).toEqual([]);
    expect(world.watcher.watching).toEqual([]);
    expect(world.watcher.closed).toEqual([STORE.path]);
  });
});

describe('a store that cannot be watched', () => {
  it('costs itself, and says so at warn', async () => {
    const world = start({ stores: [STORE, OTHER], refuse: [STORE.path] });
    const only = world.join('connection-1');

    expect(warnings(world.records)[0]).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('not watching a store'),
      fields: { storeId: STORE.storeId, path: STORE.path },
    });

    // And the other store is watched and reports, which is the point of one
    // watch per store: a bad volume must not take a good one with it.
    world.watcher.change(OTHER.path);
    await settle(world);
    expect(only.sent).toHaveLength(1);
  });

  it('tries again on the backoff, and watches it once it can', async () => {
    const world = start({ refuse: [STORE.path] });
    const only = world.join('connection-1');

    expect(world.timers.delays).toEqual([STORE_WATCH_BACKOFF_MS[0]]);
    world.timers.fireAll();
    // Still refused, so the wait grows rather than turning into a busy loop.
    expect(world.timers.delays).toEqual([STORE_WATCH_BACKOFF_MS[1]]);

    world.watcher.allow(STORE.path);
    world.timers.fireAll();

    expect(world.watcher.watching).toEqual([STORE.path]);
    world.watcher.change(STORE.path);
    await settle(world);
    expect(only.sent).toHaveLength(1);
  });

  it('re-establishes a watch that died after it was established', async () => {
    const world = start();
    const only = world.join('connection-1');

    world.watcher.fail(STORE.path, 'EBADF: the volume went away');

    expect(warnings(world.records)[0]?.fields).toMatchObject({
      problem: 'EBADF: the volume went away',
      retryInMs: STORE_WATCH_BACKOFF_MS[0],
    });
    world.timers.fireAll();

    // Back, and reporting again: a store that comes back must not need the
    // service restarted to be watched again.
    expect(world.watcher.watching).toEqual([STORE.path]);
    world.watcher.change(STORE.path);
    await settle(world);
    expect(only.sent).toHaveLength(1);
  });

  it('stops trying once the server has stopped', () => {
    const world = start({ refuse: [STORE.path] });

    world.watchers.stop();
    world.timers.fireAll();

    // One attempt at boot and nothing after it. A retry scheduled past a
    // shutdown is a timer holding a process that has finished serving.
    expect(world.watcher.attempts).toEqual([STORE.path]);
  });
});

/**
 * A scan is a disk read and a `git` child per session directory, so a second
 * one starting while the first is still running is real cost for an answer
 * that cannot have changed much. What must not happen either is losing the
 * change that arrived during it.
 */
describe('a store that changes while it is being scanned', () => {
  /** A controller whose scan does not finish until the test says so. */
  function gated(): SessionController & { readonly scans: readonly StoreId[]; open(): void } {
    const scans: StoreId[] = [];
    let release: (() => void) | null = null;
    return {
      start: () => {
        throw new Error('this controller starts nothing');
      },
      stop: () => {
        throw new Error('this controller stops nothing');
      },
      async report(storeId: StoreId): Promise<StoreReport> {
        scans.push(storeId);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return report(STORE);
      },
      open(): void {
        release?.();
        release = null;
      },
      get scans(): readonly StoreId[] {
        return scans;
      },
    };
  }

  it('waits for the scan in flight and then reports once more', async () => {
    const controller = gated();
    const world = start({ controller });
    const only = world.join('connection-1');

    world.watcher.change(STORE.path);
    world.timers.fireAll();
    await Promise.resolve();
    expect(controller.scans).toHaveLength(1);

    // Two more writes land while the store is being read. Neither starts a
    // second scan, and together they are worth exactly one more report.
    world.watcher.change(STORE.path);
    world.watcher.change(STORE.path);
    expect(controller.scans).toHaveLength(1);

    controller.open();
    await flush();
    expect(only.sent).toHaveLength(1);

    // And the window opens again only once that report is out, so the two
    // writes above are worth one more scan rather than two.
    expect(world.timers.delays).toEqual([STORE_WATCH_DEBOUNCE_MS]);
    world.timers.fireAll();
    await flush();
    expect(controller.scans).toHaveLength(2);

    controller.open();
    await flush();
    expect(only.sent).toHaveLength(2);
    expect(world.timers.pending).toBe(0);
  });
});
