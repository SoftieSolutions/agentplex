import type { StoreWatch, StoreWatchEvents, StoreWatcher, StoreWatchMode } from './store-watch.js';

/**
 * A filesystem watch a test fires by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason every
 * other fake here is one: the subject is what a change does -- one report per
 * connected hub, a burst that becomes one, a watch that dies and comes back --
 * and each of those starts with an event this produces. Asserting that
 * `fs.watch` was called would test the wiring's shape instead of its behaviour.
 *
 * Nothing here touches a disk, and nothing fires on its own. A test that wants
 * the real runtime asks `node-store-watcher.integration.test.ts`.
 */
export interface FakeStoreWatcher extends StoreWatcher {
  /** Every path a watch was attempted at, in order, the failed attempts included. */
  readonly attempts: readonly string[];
  /** The paths with a live watch on them right now. */
  readonly watching: readonly string[];
  /** Every path whose watch was closed, in order. */
  readonly closed: readonly string[];
  /** Makes every attempt at this path throw, until `allow`. */
  refuse(path: string, problem?: string): void;
  /** Lets attempts at this path succeed again. */
  allow(path: string): void;
  /** Fires a change on the live watch at this path. */
  change(path: string): void;
  /** Ends the live watch at this path the way a real one ends: an error, and nothing after it. */
  fail(path: string, problem: string): void;
}

export interface FakeStoreWatcherOptions {
  /** What an established watch says it got. Defaults to a recursive one. */
  readonly mode?: StoreWatchMode;
  /** Paths whose watch cannot be established, as though the platform refused. */
  readonly refuse?: readonly string[];
}

export function createFakeStoreWatcher(options: FakeStoreWatcherOptions = {}): FakeStoreWatcher {
  const mode = options.mode ?? 'recursive';
  const attempts: string[] = [];
  const closed: string[] = [];
  const live = new Map<string, StoreWatchEvents>();
  const refused = new Map<string, string>(
    (options.refuse ?? []).map((path) => [path, `no watch can be established on ${path}`]),
  );

  /** The live events at a path, or a failure naming what a test asked for. */
  const events = (path: string, verb: string): StoreWatchEvents => {
    const found = live.get(path);
    if (found === undefined) throw new Error(`nothing is watching ${path}, so it cannot ${verb}`);
    return found;
  };

  return {
    watch(path: string, listener: StoreWatchEvents): StoreWatch {
      attempts.push(path);
      const problem = refused.get(path);
      if (problem !== undefined) throw new Error(problem);
      live.set(path, listener);
      return {
        mode,
        close(): void {
          // Only if this watch is still the live one: a watch that ended in an
          // error was replaced by the one the retry established, and closing
          // that one here would be this fake inventing a failure.
          if (live.get(path) !== listener) return;
          live.delete(path);
          closed.push(path);
        },
      };
    },

    refuse(path: string, problem = `no watch can be established on ${path}`): void {
      refused.set(path, problem);
    },

    allow(path: string): void {
      refused.delete(path);
    },

    change(path: string): void {
      events(path, 'change').onChange();
    },

    fail(path: string, problem: string): void {
      const listener = events(path, 'fail');
      // The seam's contract: a watch that reports an error is over, so this
      // takes it out before saying so. A fake that kept it would let a test
      // pass that a real watcher could never satisfy.
      live.delete(path);
      listener.onError(problem);
    },

    get attempts(): readonly string[] {
      return attempts;
    },

    get watching(): readonly string[] {
      return [...live.keys()];
    },

    get closed(): readonly string[] {
      return closed;
    },
  };
}
