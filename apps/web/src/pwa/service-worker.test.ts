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
 * says which windows are open, and a `caches` that records every touch. The
 * worker is exercised exactly as it will be: by dispatching a `push` and a
 * `notificationclick` at the handlers it registered.
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

interface Harness {
  /**
   * Sends one event to the handler the worker registered for `type` and waits
   * for everything the handler passed to `waitUntil`. Rejects if the handler
   * throws, which is the point: a push handler that throws is a push that
   * shows nothing, and browsers penalise that.
   */
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
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

async function loadServiceWorker(windows: FakeWindow[] = []): Promise<Harness> {
  const source = await readFile(WORKER_SOURCE, 'utf8');
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: ShownNotification[] = [];
  const opened: string[] = [];
  const cacheTouches: string[] = [];

  const caches = {
    keys: (): Promise<string[]> => {
      cacheTouches.push('keys');
      return Promise.resolve([]);
    },
    open: (): Promise<unknown> => {
      cacheTouches.push('open');
      return Promise.resolve({ put: () => Promise.resolve(undefined) });
    },
    match: (): Promise<unknown> => {
      cacheTouches.push('match');
      return Promise.resolve(undefined);
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
