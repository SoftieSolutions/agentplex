import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { sessionIdSchema, sessionRefSchema, storeIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';

import { parseSessionHash, sessionHash } from '../terminal/session-route.js';

/**
 * The service worker, tested by loading the file the browser loads.
 *
 * `apps/web/public/sw.js` is a classic worker registered as `/sw.js` with no
 * `type: 'module'`, so it can import nothing from the app bundle and nothing
 * can import it. That leaves one honest seam: read the shipped file and run it
 * as a script in a context whose globals are fakes -- a `self` that collects
 * handlers, a `registration` that collects notifications, a `clients` that
 * says which windows are open, a `caches` that records every touch, a `fetch`
 * the test decides the fate of, and timers that fire only when the test says
 * so. The worker is exercised exactly as it will be: by dispatching a `push`,
 * a `notificationclick` and a navigation `fetch` at the handlers it registered.
 *
 * That the file runs at all is half of what this suite is for. It is outside
 * the module graph and outside `tsc`, so a syntax error in it is invisible to
 * every other check in this repository and would ship as a registration that
 * fails on the user's machine.
 */

const WORKER_SOURCE = new URL('../../public/sw.js', import.meta.url);

/** The origin the fake browser is on. Notifications may not leave it. */
const ORIGIN = 'https://hub.example';

interface ShownNotification {
  readonly title: string;
  readonly options: Record<string, unknown>;
}

/** A window the fake browser has open, and what the worker did to it. */
interface FakeWindow {
  url: string;
  focused: boolean;
  navigatedTo: string | null;
  /** Set when `navigate` is contracted to reject, as a browser's may. */
  readonly refusesNavigation?: boolean;
}

/** A timer the worker scheduled and the test has not yet fired or seen cleared. */
interface FakeTimer {
  readonly delay: number;
  readonly fire: () => void;
}

interface WorkerOptions {
  /**
   * What the worker's `fetch` does. The default throws, which no existing
   * suite reaches: only a navigation calls it.
   */
  readonly fetch?: () => Promise<unknown>;
  /** What `caches.match` answers: the shell a previous visit left behind. */
  readonly cachedShell?: unknown;
}

/** One navigation handed to the worker without waiting on anything it started. */
interface Navigation {
  /** The promise the worker passed to `respondWith`. */
  readonly response: Promise<unknown>;
  /** Everything the worker passed to `waitUntil`. */
  readonly background: readonly Promise<unknown>[];
}

interface Harness {
  /**
   * Sends one event to the handler the worker registered for `type` and waits
   * for everything the handler passed to `waitUntil`. Rejects if the handler
   * throws, which is the point: a push handler that throws is a push that
   * shows nothing, and browsers penalise that.
   */
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
  /**
   * Sends a navigation `fetch` and returns at once. `dispatch` would wait on
   * the worker's `waitUntil`, which for a network that never answers is never.
   */
  navigate(): Navigation;
  /** Fires every timer still scheduled, in the order they were set. */
  fireTimers(): void;
  /** The delay of every timer the worker ever scheduled. */
  readonly scheduledDelays: readonly number[];
  /** How many scheduled timers have neither fired nor been cleared. */
  readonly liveTimers: number;
  /** How many times the worker called `fetch`. */
  readonly fetches: number;
  /** The worker's own `SHELL_NETWORK_TIMEOUT_MS`, read out of its realm. */
  readonly shellNetworkTimeoutMs: number;
  readonly shown: ShownNotification[];
  readonly opened: readonly string[];
  readonly windows: readonly FakeWindow[];
  /** Every call the worker made into the cache storage, by name. */
  readonly cacheTouches: readonly string[];
  /** The worker's own spelling of a session's address. */
  sessionHashFor(ref: { storeId: string; sessionId: string }): string;
  readonly source: string;
}

function windowClient(scope: { windows: FakeWindow[] }, entry: FakeWindow): object {
  return {
    get url(): string {
      return entry.url;
    },
    focus(): Promise<unknown> {
      entry.focused = true;
      return Promise.resolve(entry);
    },
    navigate(url: string): Promise<unknown> {
      if (entry.refusesNavigation === true) {
        return Promise.reject(new Error('this client may not be navigated'));
      }
      entry.navigatedTo = url;
      entry.url = new URL(url, `${ORIGIN}/`).href;
      return Promise.resolve(windowClient(scope, entry));
    },
  };
}

async function loadServiceWorker(
  windows: FakeWindow[] = [],
  options: WorkerOptions = {},
): Promise<Harness> {
  const source = await readFile(WORKER_SOURCE, 'utf8');
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: ShownNotification[] = [];
  const opened: string[] = [];
  const cacheTouches: string[] = [];
  const timers = new Map<number, FakeTimer>();
  const scheduledDelays: number[] = [];
  let nextTimer = 1;
  let fetches = 0;

  const caches = {
    keys: (): Promise<string[]> => {
      cacheTouches.push('keys');
      return Promise.resolve([]);
    },
    open: (): Promise<unknown> => {
      cacheTouches.push('open');
      return Promise.resolve({
        put: (): Promise<undefined> => {
          cacheTouches.push('put');
          return Promise.resolve(undefined);
        },
      });
    },
    match: (): Promise<unknown> => {
      cacheTouches.push('match');
      return Promise.resolve(options.cachedShell);
    },
    delete: (): Promise<boolean> => {
      cacheTouches.push('delete');
      return Promise.resolve(true);
    },
  };

  // The sandbox is the worker's global object: `self` points at it, so both
  // `self.clients` and a bare `caches` resolve the way they do in a browser.
  const sandbox: Record<string, unknown> = {
    URL,
    caches,
    console,
    fetch: (): Promise<unknown> => {
      fetches += 1;
      if (options.fetch === undefined) throw new Error('this test gave the worker no network');
      return options.fetch();
    },
    setTimeout: (fire: () => void, delay: number): number => {
      const id = nextTimer;
      nextTimer += 1;
      scheduledDelays.push(delay);
      timers.set(id, { delay, fire });
      return id;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      handlers.set(type, handler);
    },
    skipWaiting: (): void => {},
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    registration: {
      scope: `${ORIGIN}/`,
      showNotification: (title: string, options: Record<string, unknown>): Promise<void> => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: (): Promise<void> => Promise.resolve(),
      matchAll: (): Promise<unknown[]> =>
        Promise.resolve(windows.map((entry) => windowClient({ windows }, entry))),
      openWindow: (url: string): Promise<unknown> => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  sandbox.self = sandbox;
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'sw.js' });

  const spelling = sandbox.sessionHashFor;
  if (typeof spelling !== 'function') {
    throw new Error('sw.js no longer declares sessionHashFor: the address pin below cannot run');
  }

  return {
    async dispatch(type, event) {
      const handler = handlers.get(type);
      if (handler === undefined) throw new Error(`sw.js registered no ${type} handler`);
      const pending: Promise<unknown>[] = [];
      handler({
        ...event,
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await Promise.all(pending);
    },
    navigate() {
      const handler = handlers.get('fetch');
      if (handler === undefined) throw new Error('sw.js registered no fetch handler');
      let response: Promise<unknown> | undefined;
      const background: Promise<unknown>[] = [];
      handler({
        request: { mode: 'navigate' },
        respondWith: (promise: Promise<unknown>) => {
          response = promise;
        },
        waitUntil: (promise: Promise<unknown>) => background.push(promise),
      });
      if (response === undefined) throw new Error('sw.js did not answer a navigation');
      return { response, background };
    },
    fireTimers() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fire();
    },
    scheduledDelays,
    get liveTimers() {
      return timers.size;
    },
    get fetches() {
      return fetches;
    },
    get shellNetworkTimeoutMs() {
      // A top-level `const` is a binding in the script's scope, not a property
      // of its global, so it is read by evaluating its name in that realm.
      const value: unknown = runInContext(
        "typeof SHELL_NETWORK_TIMEOUT_MS === 'number' ? SHELL_NETWORK_TIMEOUT_MS : undefined",
        sandbox,
      );
      if (typeof value !== 'number') throw new Error('sw.js declares no SHELL_NETWORK_TIMEOUT_MS');
      return value;
    },
    shown,
    opened,
    windows,
    cacheTouches,
    sessionHashFor(ref) {
      return String(spelling(ref));
    },
    source,
  };
}

/** The payload `apps/hub/src/push/push.ts` sends, verbatim. */
function hubPayload(storeId = 'store-work', sessionId = 'session-1'): Record<string, unknown> {
  return {
    title: 'claude',
    body: 'awaiting permission',
    data: { storeId, sessionId },
  };
}

function pushEventFor(payload: unknown): Record<string, unknown> {
  return { data: { json: () => payload } };
}

function ref(storeId: string, sessionId: string) {
  return sessionRefSchema.parse({
    storeId: storeIdSchema.parse(storeId),
    sessionId: sessionIdSchema.parse(sessionId),
  });
}

/** The payload `push.ts` sends for a graph run waiting on a person, verbatim. */
function runPayload(graph = 'node-graph-release'): Record<string, unknown> {
  return {
    title: 'graph run',
    body: '#38 is waiting at Approve merge',
    data: { graph },
  };
}

describe('the service worker on a push about a graph run', () => {
  it('shows the run and the node, and carries the graph to tap on', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', pushEventFor(runPayload()));

    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe('agentplex');
    expect(worker.shown[0]?.options.body).toBe('graph run #38 is waiting at Approve merge');
    expect(worker.shown[0]?.options.data).toEqual({ graph: 'node-graph-release' });
    expect(worker.shown[0]?.options.tag).toBe('#/graph/node-graph-release');
  });

  it('opens the graph on a tap, at the address the app parses', async () => {
    const worker = await loadServiceWorker([]);

    await worker.dispatch('notificationclick', {
      notification: { data: { graph: 'node/graph 1' }, close: () => {} },
    });

    expect(worker.opened).toEqual(['/#/graph/node%2Fgraph%201']);
  });

  it('shows the generic notification for a graph payload with no id', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', pushEventFor({ ...runPayload(), data: { graph: '' } }));

    expect(worker.shown[0]?.options.body).toBe('a session wants you');
    expect(worker.shown[0]?.options.data).toBeNull();
  });
});

describe('the service worker on a push', () => {
  it('shows one notification: the app above, the hub words below', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', pushEventFor(hubPayload()));

    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe('agentplex');
    expect(worker.shown[0]?.options.body).toBe('claude awaiting permission');
    expect(worker.shown[0]?.options.data).toEqual({
      storeId: 'store-work',
      sessionId: 'session-1',
    });
  });

  it('tags per session, so a second prompt replaces the first rather than stacking', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', pushEventFor(hubPayload()));
    await worker.dispatch('push', pushEventFor(hubPayload()));
    await worker.dispatch('push', pushEventFor(hubPayload('store-work', 'session-2')));

    const tags = worker.shown.map((notification) => notification.options.tag);
    expect(tags[0]).toBe(tags[1]);
    expect(tags[0]).not.toBe(tags[2]);
    expect(tags.every((tag) => typeof tag === 'string' && tag.length > 0)).toBe(true);
  });

  it('shows a generic notification rather than none when the payload does not parse', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('not JSON');
        },
      },
    });
    await worker.dispatch('push', pushEventFor({ body: 'awaiting input' }));
    await worker.dispatch('push', pushEventFor(null));
    await worker.dispatch('push', {});

    expect(worker.shown).toHaveLength(4);
    for (const notification of worker.shown) {
      expect(notification.title).toBe('agentplex');
      expect(notification.options.body).toBe('a session wants you');
      expect(notification.options.data).toBeNull();
    }
  });

  it('never touches the offline shell cache, on the push or on the tap', async () => {
    const worker = await loadServiceWorker();

    await worker.dispatch('push', pushEventFor(hubPayload()));
    await worker.dispatch('notificationclick', {
      notification: { data: { storeId: 'store-work', sessionId: 'session-1' }, close: () => {} },
    });

    expect(worker.cacheTouches).toEqual([]);
  });

  it('keeps the shell cache name it had: the file is served no-cache', async () => {
    const worker = await loadServiceWorker();

    expect(worker.source).toContain("'agentplex-shell-v1'");
  });
});

/** A promise that never settles: a network that has stopped answering. */
function never(): Promise<unknown> {
  return new Promise(() => {});
}

/** A fetch the test settles by hand, after whatever the worker has done by then. */
function deferred(): {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Lets every callback already queued in either realm run. Uses this realm's
 * real timer: the worker's is a fake that fires only when told to.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const PENDING = Symbol('pending');

/**
 * What a promise has done so far, without waiting for it to do more.
 *
 * Not a `Promise.race` against a resolved sentinel: the sentinel wins that by
 * a microtask even over a promise that has already settled, and a promise
 * from the worker's realm is adopted as a foreign thenable, one hop later
 * still. Handlers recorded first and read after a real macrotask see every
 * settlement both realms had queued.
 */
async function stateOf(promise: Promise<unknown>): Promise<unknown> {
  let state: unknown = PENDING;
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  await flush();
  return state;
}

function networkResponse(): { ok: true; clone: () => object } {
  return { ok: true, clone: () => ({}) };
}

describe('the service worker on a navigation', () => {
  it('serves the cached shell once the network misses the deadline', async () => {
    const cachedShell = { shell: 'the last one the network served' };
    const worker = await loadServiceWorker([], { fetch: never, cachedShell });

    const { response } = worker.navigate();
    expect(worker.scheduledDelays).toEqual([worker.shellNetworkTimeoutMs]);
    worker.fireTimers();

    await expect(response).resolves.toBe(cachedShell);
    expect(worker.cacheTouches).toContain('match');
  });

  it('serves the network response when it arrives first, keeps it, and clears the timer', async () => {
    const fromNetwork = networkResponse();
    const worker = await loadServiceWorker([], {
      fetch: () => Promise.resolve(fromNetwork),
      cachedShell: { shell: 'stale' },
    });

    const { response, background } = worker.navigate();

    await expect(response).resolves.toBe(fromNetwork);
    await Promise.all(background);
    expect(worker.cacheTouches).toEqual(['open', 'put']);
    expect(worker.scheduledDelays).toHaveLength(1);
    expect(worker.liveTimers).toBe(0);
  });

  it('keeps waiting on the network past the deadline when there is no cached shell', async () => {
    const worker = await loadServiceWorker([], { fetch: never });

    const { response } = worker.navigate();
    worker.fireTimers();

    expect(await stateOf(response)).toBe(PENDING);
    expect(worker.cacheTouches).toContain('match');
  });

  it('still answers with the late network response when there is no cached shell', async () => {
    const network = deferred();
    const fromNetwork = networkResponse();
    const worker = await loadServiceWorker([], { fetch: () => network.promise });

    const { response, background } = worker.navigate();
    worker.fireTimers();
    await flush();
    network.resolve(fromNetwork);

    await expect(response).resolves.toBe(fromNetwork);
    await Promise.all(background);
    expect(worker.cacheTouches).toContain('put');
  });

  it('keeps the late response in the cache after serving the cached shell', async () => {
    const network = deferred();
    const worker = await loadServiceWorker([], {
      fetch: () => network.promise,
      cachedShell: { shell: 'stale' },
    });

    const { response, background } = worker.navigate();
    worker.fireTimers();
    await response;
    expect(worker.cacheTouches).not.toContain('put');

    network.resolve(networkResponse());
    await Promise.all(background);
    expect(worker.cacheTouches).toContain('put');
  });

  it('surfaces the failure when the network fails after the deadline and nothing is cached', async () => {
    const network = deferred();
    const worker = await loadServiceWorker([], { fetch: () => network.promise });
    const offline = new Error('offline');

    const { response, background } = worker.navigate();
    worker.fireTimers();
    await flush();
    network.reject(offline);

    await expect(response).rejects.toBe(offline);
    // The branch kept alive for the cache write swallows the same failure, so
    // nothing escapes the worker as an unhandled rejection.
    await expect(Promise.all(background)).resolves.toBeDefined();
  });

  it('serves the cached shell at once when the network fails before the deadline', async () => {
    const cachedShell = { shell: 'the last one the network served' };
    const worker = await loadServiceWorker([], {
      fetch: () => Promise.reject(new Error('offline')),
      cachedShell,
    });

    const { response } = worker.navigate();

    await expect(response).resolves.toBe(cachedShell);
    expect(worker.liveTimers).toBe(0);
  });

  it('answers nothing but navigations', async () => {
    const worker = await loadServiceWorker([], { fetch: never });
    let answered = 0;

    await worker.dispatch('fetch', {
      request: { mode: 'no-cors' },
      respondWith: () => {
        answered += 1;
      },
    });

    expect(answered).toBe(0);
    expect(worker.fetches).toBe(0);
    expect(worker.scheduledDelays).toEqual([]);
    expect(worker.cacheTouches).toEqual([]);
  });
});

describe('the service worker on a tap', () => {
  const openAt = (url: string): FakeWindow => ({ url, focused: false, navigatedTo: null });

  it('closes the notification and focuses the open window at the session address', async () => {
    const window = openAt(`${ORIGIN}/`);
    const worker = await loadServiceWorker([window]);
    let closed = 0;

    await worker.dispatch('notificationclick', {
      notification: {
        data: { storeId: 'store-work', sessionId: 'session-1' },
        close: () => {
          closed += 1;
        },
      },
    });

    expect(closed).toBe(1);
    expect(window.navigatedTo).toBe('/#/session/store-work/session-1');
    expect(window.focused).toBe(true);
    expect(worker.opened).toEqual([]);
  });

  it('opens a window at the session address when none is open', async () => {
    const worker = await loadServiceWorker([]);

    await worker.dispatch('notificationclick', {
      notification: { data: { storeId: 'store/one', sessionId: 'session 1' }, close: () => {} },
    });

    expect(worker.opened).toEqual(['/#/session/store%2Fone/session%201']);
  });

  it('stays within this origin: a foreign window is not the app', async () => {
    const foreign = openAt('https://elsewhere.example/');
    const worker = await loadServiceWorker([foreign]);

    await worker.dispatch('notificationclick', {
      notification: { data: { storeId: 'store-work', sessionId: 'session-1' }, close: () => {} },
    });

    expect(foreign.navigatedTo).toBeNull();
    expect(foreign.focused).toBe(false);
    expect(worker.opened).toEqual(['/#/session/store-work/session-1']);
  });

  it('opens the app itself when the notification names no session', async () => {
    const worker = await loadServiceWorker([]);

    await worker.dispatch('notificationclick', {
      notification: { data: null, close: () => {} },
    });

    expect(worker.opened).toEqual(['/']);
  });

  it('still focuses a window whose navigation the browser refuses', async () => {
    const stubborn: FakeWindow = {
      url: `${ORIGIN}/`,
      focused: false,
      navigatedTo: null,
      refusesNavigation: true,
    };
    const worker = await loadServiceWorker([stubborn]);

    await worker.dispatch('notificationclick', {
      notification: { data: { storeId: 'store-work', sessionId: 'session-1' }, close: () => {} },
    });

    expect(stubborn.focused).toBe(true);
    expect(worker.opened).toEqual([]);
  });
});

describe('the address the worker sends a tap to', () => {
  /**
   * The pin. `sessionHash` in `../terminal/session-route.ts` is the original
   * and the worker cannot import it, so the two spellings are kept honest here
   * rather than by hoping: this reads the function out of the loaded worker and
   * asks the app's own parser to read what it produced.
   */
  it('is spelled exactly as the app spells it', async () => {
    const worker = await loadServiceWorker();

    for (const [storeId, sessionId] of [
      ['store-work', 'session-1'],
      ['store/one', 'session 1'],
      ['store#hash', 'session?query'],
      ['store ünïcode', 'session-%2F'],
    ]) {
      const parsed = ref(String(storeId), String(sessionId));
      const spelled = worker.sessionHashFor({
        storeId: String(storeId),
        sessionId: String(sessionId),
      });
      expect(spelled).toBe(sessionHash(parsed));
      expect(parseSessionHash(spelled)).toEqual(parsed);
    }
  });
});
