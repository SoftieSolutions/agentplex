import { watch, type FSWatcher } from 'node:fs';
import {
  STORE_WATCH_POLL_MS,
  type StoreWatch,
  type StoreWatchEvents,
  type StoreWatcher,
} from './store-watch.js';

/**
 * The real filesystem, named in one place: this is the only file in the
 * repository that calls `fs.watch`.
 *
 * Everything about what a change means -- the burst window, the fan-out, the
 * backoff -- lives behind the seam in `store-watch.ts`, where a test can reach
 * it. What is left here is the part a test cannot check without a kernel: which
 * mechanism this platform will actually give, and what it does when it will not
 * give the good one.
 *
 * **Recursive, because a store is a tree.** A provider writes its transcripts
 * into directories below the store root -- one per working directory, and a
 * file per session inside it -- so a watch on the root alone would see a new
 * project directory appear and nothing that happened in it afterwards. macOS
 * (FSEvents) and Linux on Node 24 both support `recursive: true`, which was run
 * on both rather than taken from the documentation; the fallback below is for
 * the platforms that refuse.
 *
 * **`persistent: false`, because a watch must not hold the process open.** The
 * listener is what keeps this server alive, exactly as the timer behind the
 * beacon is unref'd for the same reason: a shutdown that has closed everything
 * it serves should exit, not sit in the event loop because something is
 * watching a directory.
 */

/** Node's answer when `recursive` is not available on this platform. */
const UNAVAILABLE = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';

export const nodeStoreWatcher: StoreWatcher = {
  watch(path: string, events: StoreWatchEvents): StoreWatch {
    let watcher: FSWatcher;
    try {
      watcher = watch(path, { recursive: true, persistent: false });
    } catch (error) {
      // Only the one refusal falls back. Anything else -- the directory is
      // gone, the process is out of watch descriptors -- is a failure to
      // establish, and the caller's backoff is what that is for. Turning every
      // error into a poll would quietly report a store nobody can read.
      if (errorCode(error) !== UNAVAILABLE) throw error;
      return pollInstead(events);
    }

    watcher.on('change', () => events.onChange());
    watcher.on('error', (error) => {
      // Closed here rather than left to the caller, because the seam promises
      // that a watch which reported an error is over: an `FSWatcher` that
      // errored may still hold a descriptor, and the caller is about to
      // establish a second one.
      watcher.close();
      events.onError(String(error));
    });

    return {
      mode: 'recursive',
      close(): void {
        watcher.close();
      },
    };
  },
};

/**
 * The fallback: say the store changed every interval, and let the report say
 * whether it did.
 *
 * A tick rather than a crawl of the tree -- see `STORE_WATCH_POLL_MS` for why
 * walking it would cost about what the scan it is deciding about costs. The
 * handle is unref'd for the same reason the watch above is not persistent.
 */
function pollInstead(events: StoreWatchEvents): StoreWatch {
  const handle = setInterval(() => events.onChange(), STORE_WATCH_POLL_MS);
  handle.unref?.();
  return {
    mode: 'polling',
    close(): void {
      clearInterval(handle);
    },
  };
}

/** Node's errno is a property on an `Error`, not a type: read it as a claim. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
