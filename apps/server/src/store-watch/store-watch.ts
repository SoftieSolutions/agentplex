import type { StoreDescriptor } from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';
import type { HubAudience } from '../hub/hub-audience.js';

/**
 * Noticing that a store changed without being told.
 *
 * Every store report before this one was scan-on-demand: a hub handshakes, a
 * session starts, a session stops, a drain polls. Each of those is this server
 * being asked, and the sessions this server was never asked about are exactly
 * the ones somebody started in a terminal. Until one of those events happened
 * to land, a session running on this machine was invisible to every hub, and
 * the catalogue a hub publishes was only ever as fresh as the last thing a hub
 * did. That is the gap `hub-connection.ts` names where it sends reports, and
 * this is the thing it names.
 *
 * **It adds no way to report a store.** A change goes through
 * `audience.reportToAll`, which is the same call a start and a stop make: one
 * scan, every connected hub, each hub's own start tags taken as its copy goes
 * out. A second path would be a second thing to keep true, and a store report
 * is already unsolicited and whole.
 *
 * **The watch is a seam.** `node-store-watcher.ts` is the only file in the
 * repository that touches `fs.watch`, so everything here -- the debounce, the
 * fan-out, the backoff, the refusal to scan for nobody -- is testable without a
 * filesystem that fires events on a schedule nothing controls.
 *
 * **It is a floor-raiser and never a floor.** Every event this misses is still
 * caught by the scan a handshake, a start, a stop or a drain does. That is what
 * makes a watch that cannot be established survivable: the store costs itself,
 * the server comes up, and reports keep arriving on the old triggers.
 */

/**
 * How long a burst is allowed to be before it becomes one report.
 *
 * A transcript is not written once. Every provider here appends to a JSONL file
 * as its agent works, so a single answer is tens of writes, and each of them is
 * an event on this watch. Without a window each write would cost a full scan of
 * the store plus a `git status` and a `git diff` per session directory, sent to
 * every connected hub -- a server driving one busy session would spend most of
 * a core telling hubs what they already knew.
 *
 * Two seconds is the number because it is on both sides of the thing that
 * matters. A person who starts `claude` in a terminal and looks at the client
 * does not experience two seconds as a wait, and two seconds is the *floor* on
 * how often a store is rescanned rather than an added delay: an idle store
 * fires nothing at all.
 *
 * The window is armed by the first event and not reset by the ones after it,
 * which is the difference between this and a plain debounce. A debounce that
 * restarted on every event would report nothing at all while an agent was
 * writing -- the case with the most to report -- and would only settle once the
 * machine went quiet.
 */
export const STORE_WATCH_DEBOUNCE_MS = 2_000;

/**
 * How often a store is reported where the platform refuses a recursive watch,
 * in milliseconds.
 *
 * The fallback is a tick and not a crawl: walking the tree to find out whether
 * anything changed costs about what scanning the store costs, so it would buy
 * nothing over simply scanning it. Thirty seconds is slow enough to be
 * negligible on a machine that is doing nothing and fast enough that a session
 * somebody started by hand appears while they are still looking for it.
 *
 * macOS and Linux on Node 24 both watch recursively -- this was run on both,
 * not assumed -- so nothing agentplex ships on today reaches this. It is here
 * because the alternative to a stated interval is a platform where the watcher
 * silently does nothing.
 */
export const STORE_WATCH_POLL_MS = 30_000;

/**
 * How long to wait before establishing a watch again, by attempt.
 *
 * A watch fails for reasons that pass -- a volume unmounted, an inotify limit a
 * neighbouring process is holding -- and for reasons that do not, and nothing
 * here can tell the two apart. So it keeps trying and the interval grows to a
 * minute, where it stays: at a minute a broken store costs one `fs.watch` call
 * and one log line a minute, and a volume that comes back is watched again
 * within one of them without anybody restarting the service.
 */
export const STORE_WATCH_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * How long to wait after this many consecutive failures, which stops growing at
 * the last step rather than running off the end of the list.
 *
 * A function rather than an index at the call site so that the clamp is written
 * once and the last step is reached by arithmetic instead of by a cast.
 */
export function storeWatchBackoffMs(failures: number): number {
  const steps = STORE_WATCH_BACKOFF_MS;
  return steps[Math.min(Math.max(failures, 0), steps.length - 1)] ?? steps[0];
}

/** Which mechanism a watch actually got. */
export type StoreWatchMode = 'recursive' | 'polling';

/** One established watch, as the thing that established it can end it. */
export interface StoreWatch {
  /**
   * Said out loud because the two are not the same promise: a recursive watch
   * reports a change when it happens, and the fallback reports the store on a
   * fixed interval whether or not anything moved.
   */
  readonly mode: StoreWatchMode;
  /** Ends the watch. Calling it twice is safe. */
  close(): void;
}

/** What a watch tells whoever established it. */
export interface StoreWatchEvents {
  /**
   * Something under the watched root changed.
   *
   * No path and no event kind: a store report is the whole store, so knowing
   * which file moved would change nothing about what is sent. An
   * implementation that filtered by filename would be deciding which of a
   * provider's files matter, which is the adapter's judgement and not the
   * watcher's.
   */
  onChange(): void;
  /**
   * The watch failed after it was established, and is over.
   *
   * Nothing arrives after this: an implementation that reports an error has
   * already closed whatever it held, so the caller re-establishes rather than
   * waiting for a recovery it cannot observe.
   */
  onError(problem: string): void;
}

/**
 * The filesystem watch, as everything above it sees it.
 *
 * `watch` throws when a watch cannot be established. That is the one case a
 * caller must handle rather than a value it must remember to check, and it is
 * the shape the runtime underneath already has.
 */
export interface StoreWatcher {
  watch(path: string, events: StoreWatchEvents): StoreWatch;
}

export interface StoreWatchDependencies {
  /** The stores this server mounted. A store it could not read is not in here. */
  readonly stores: readonly StoreDescriptor[];
  readonly watcher: StoreWatcher;
  /**
   * Where a change goes, and the reason this takes the audience rather than a
   * callback: the report path is `reportToAll` and there is to be no second
   * one. It is also what answers whether anybody is connected, which is what
   * keeps a server nobody has dialled from scanning a store for nobody.
   */
  readonly audience: HubAudience;
  readonly timers: Timers;
  readonly logger: Logger;
  /** The burst window, in milliseconds. Defaults to `STORE_WATCH_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

export interface StoreWatchers {
  /**
   * Stops watching every store: no more events, no pending report, no pending
   * retry. Safe to call more than once.
   */
  stop(): void;
}

/**
 * Watches every mounted store, and reports each one that changes.
 *
 * One watch per store rather than one per server, because a failure is a fact
 * about a volume: a store on a filesystem that cannot be watched must not cost
 * the store on the one that can.
 */
export function watchStores({
  stores,
  watcher,
  audience,
  timers,
  logger,
  debounceMs = STORE_WATCH_DEBOUNCE_MS,
}: StoreWatchDependencies): StoreWatchers {
  const watches = stores.map((store) =>
    watchStore({ store, watcher, audience, timers, logger, debounceMs }),
  );

  return {
    stop(): void {
      for (const watch of watches) watch.stop();
    },
  };
}

interface OneStoreDependencies {
  readonly store: StoreDescriptor;
  readonly watcher: StoreWatcher;
  readonly audience: HubAudience;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly debounceMs: number;
}

function watchStore({
  store,
  watcher,
  audience,
  timers,
  logger,
  debounceMs,
}: OneStoreDependencies): StoreWatchers {
  const { storeId, path } = store;

  /** The live watch, or `null` between a failure and the next attempt. */
  let watch: StoreWatch | null = null;
  /** Cancels the burst window, or `null` when no report is due. */
  let window: (() => void) | null = null;
  /** Cancels the wait before the next attempt, or `null` when none is waiting. */
  let waiting: (() => void) | null = null;
  /** Whether a report is in flight. Two scans of one store at once are one too many. */
  let reporting = false;
  /** Whether something changed while that report was being made. */
  let again = false;
  /** How many attempts have failed in a row, which is where the backoff is read. */
  let failures = 0;
  let stopped = false;

  const arm = (): void => {
    if (stopped || window !== null || reporting) return;
    window = timers.schedule(debounceMs, () => {
      window = null;
      void report();
    });
  };

  const report = async (): Promise<void> => {
    reporting = true;
    try {
      // Nobody to tell is nobody to scan for. A hub that connects later is
      // sent this store on its handshake, so nothing is lost by not scanning
      // for an empty room -- and a laptop running an agent with no hub dialled
      // in is the case where a scan every window would be pure waste.
      if (audience.connected === 0) return;
      await audience.reportToAll(storeId);
    } catch (error) {
      // The audience swallows a scan that failed and this catches the rest,
      // because the caller is a timer: a rejection here is an unhandled one,
      // and one report that did not go out is not a reason to stop watching.
      logger.warn('could not report a store that changed', { storeId, problem: String(error) });
    } finally {
      reporting = false;
      // Whatever happened while the store was being scanned is news the scan
      // may not have seen. It gets its own window rather than an immediate
      // report, so a store that is being written to continuously is reported
      // at the window's rate and not as fast as a scan can finish.
      if (again) {
        again = false;
        arm();
      }
    }
  };

  const onChange = (): void => {
    if (stopped) return;
    if (reporting) {
      again = true;
      return;
    }
    arm();
  };

  const onError = (problem: string): void => {
    // The watch is over by contract, so there is nothing here to close.
    watch = null;
    retry(problem);
  };

  const retry = (problem: string): void => {
    if (stopped) return;
    const afterMs = storeWatchBackoffMs(failures);
    failures += 1;
    // Warn and not error: what a store loses is freshness between the events
    // that already report it, and a server whose watches are all gone is still
    // a server that answers every hub.
    logger.warn('not watching a store: it is reported when a hub asks until this recovers', {
      storeId,
      path,
      problem,
      retryInMs: afterMs,
    });
    waiting = timers.schedule(afterMs, () => {
      waiting = null;
      establish();
    });
  };

  const establish = (): void => {
    if (stopped) return;
    try {
      watch = watcher.watch(path, { onChange, onError });
    } catch (error) {
      retry(String(error));
      return;
    }
    failures = 0;
    logger.info('watching a store', { storeId, path, mode: watch.mode, debounceMs });
  };

  establish();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      window?.();
      window = null;
      waiting?.();
      waiting = null;
      watch?.close();
      watch = null;
    },
  };
}
