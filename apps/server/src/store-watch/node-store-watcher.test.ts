import { describe, expect, it } from 'vitest';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createNodeStoreWatcher, type FsWatch } from './node-store-watcher.js';
import { STORE_WATCH_POLL_MS, type StoreWatchEvents } from './store-watch.js';

/**
 * The fallback, without a platform that refuses a recursive watch.
 *
 * Every platform agentplex ships on grants one, so the integration test cannot
 * reach this branch: the refusal is injected here instead, as the error Node
 * throws for it, and the interval is the fake clock's. What the real `fs.watch`
 * does is `node-store-watcher.integration.test.ts`'s claim.
 */

/** A `watch` that refuses the way Node does, with the code it is given. */
function refusing(code: string): FsWatch {
  return () => {
    throw Object.assign(new Error(`refused: ${code}`), { code });
  };
}

function counting(): StoreWatchEvents & { readonly changes: number } {
  let changes = 0;
  return {
    onChange: () => void (changes += 1),
    onError: (problem) => {
      throw new Error(`a poll has no error to report, and reported ${problem}`);
    },
    get changes(): number {
      return changes;
    },
  };
}

describe('a platform that refuses a recursive watch', () => {
  it('polls the store instead, on the interval it names', () => {
    const timers = createFakeTimers();
    const watcher = createNodeStoreWatcher({
      timers,
      watch: refusing('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'),
    });
    const events = counting();

    const watch = watcher.watch('/volumes/claude', events);

    expect(watch.mode).toBe('polling');
    expect(timers.delays).toEqual([STORE_WATCH_POLL_MS]);
    expect(events.changes).toBe(0);

    timers.fireAll();

    // One tick is one change, and the next tick is already waiting: a poll
    // that fired once and stopped would be a watch that quietly went away.
    expect(events.changes).toBe(1);
    expect(timers.delays).toEqual([STORE_WATCH_POLL_MS]);
  });

  it('keeps polling after a tick whose change threw', () => {
    const timers = createFakeTimers();
    const watcher = createNodeStoreWatcher({
      timers,
      watch: refusing('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'),
    });

    watcher.watch('/volumes/claude', {
      onChange: () => {
        throw new Error('the report blew up');
      },
      onError: () => {},
    });

    expect(() => timers.fireAll()).toThrow('the report blew up');
    expect(timers.delays).toEqual([STORE_WATCH_POLL_MS]);
  });

  it('leaves nothing scheduled once it is closed', () => {
    const timers = createFakeTimers();
    const watcher = createNodeStoreWatcher({
      timers,
      watch: refusing('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'),
    });
    const events = counting();

    const watch = watcher.watch('/volumes/claude', events);
    timers.fireAll();
    watch.close();

    expect(timers.pending).toBe(0);
    timers.fireAll();
    expect(events.changes).toBe(1);
  });

  it('stays closed when it is closed from inside a tick', () => {
    const timers = createFakeTimers();
    const watcher = createNodeStoreWatcher({
      timers,
      watch: refusing('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'),
    });
    let ticks = 0;
    const watch = watcher.watch('/volumes/claude', {
      onChange: () => {
        ticks += 1;
        watch.close();
      },
      onError: () => {},
    });

    timers.fireAll();

    expect(ticks).toBe(1);
    expect(timers.pending).toBe(0);
  });
});

describe('a watch that cannot be established for any other reason', () => {
  it('throws, so the backoff decides what happens next', () => {
    const timers = createFakeTimers();
    const watcher = createNodeStoreWatcher({ timers, watch: refusing('ENOENT') });

    expect(() => watcher.watch('/volumes/gone', counting())).toThrow('refused: ENOENT');
    // Not a poll: turning every error into one would quietly report a store
    // nobody can read.
    expect(timers.pending).toBe(0);
  });
});
