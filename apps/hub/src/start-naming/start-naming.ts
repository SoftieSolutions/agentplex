import type { SessionRef, SessionStartTag, StartId, StoreId } from '@agentplex/protocol';
import type { Logger, Timers } from '@agentplex/node-shared';

/**
 * The join between a spawn this hub made and the session a server later says
 * it became, for whichever of the two arrives first.
 *
 * ## Why there is a join at all
 *
 * A spawn has no session id when it is started: the provider mints one and
 * writes it, and the hub learns the pair from the start tag a server reports.
 * That tag lands on another socket from the start's own answer, and a server
 * that has already scanned reports it while the hub is still walking back up
 * from the answer -- in practice more often than not. So each half waits for
 * the other: a naming nobody has asked for yet is held by start handle for a
 * `claim`, and a start that asked first is held by start handle for the
 * naming, with what to do once it comes. `tasks.ts` argues the race at length.
 *
 * ## Why every entry has a deadline
 *
 * Each consumer used to hold both halves in two plain maps, and neither map
 * ever let go of an entry nobody completed. Every spawn is reported to every
 * consumer, so each one kept a session ref for every start it did not make
 * or did not care about -- a prompt-less start, another feature's spawn, a
 * start made by a hub that has since restarted -- and a prompt for every spawn
 * that died before its provider wrote a line. One entry per spawn, for the life
 * of the hub. Here each entry arms one timer when it is filed and is dropped
 * when the timer fires; pairing it cancels the timer first.
 *
 * ## Why this is a feature and not a seam
 *
 * It is stateful and constructed once per consumer, so that one consumer's
 * claim cannot take a naming another is also waiting on: tasks and the graph
 * executor each hear every tag and each pair their own starts. It is a folder
 * rather than a file inside one of them because both import it, and the lint
 * rule about who may reach whom names its folders -- the entry file is the one
 * way in.
 *
 * ## A store it was not made for
 *
 * A start is made for one store, and a naming reported under another has
 * nowhere to go that would not attach this start's consequences to a session
 * it is not about. It is refused and logged in one place. On `claim` the held
 * naming is dropped either way: it was the only one this start will get, and
 * keeping a refused one would only refuse it again. On `named` the expectation
 * is kept, because the right naming may yet arrive under the right store, and
 * its deadline bounds how long that hope costs.
 */

/**
 * How long either half waits for the other before it is dropped, unless the
 * consumer says otherwise.
 *
 * Five minutes. The race this covers is short -- the tag and the start's
 * answer are usually milliseconds apart, and the slowest honest case is a
 * provider that takes a while to write its first transcript line on a loaded
 * machine, which is seconds to a minute. Five minutes is well past that, and
 * short enough that a hub which spawns all day holds a bounded handful of refs
 * rather than one per dead or foreign spawn for its whole life.
 *
 * The trade, stated: a spawn named later than this loses what was waiting on
 * it. For the tasks feature that is the label -- the session runs and appears
 * like any other, with no TASK -- which is the direction that does not
 * over-claim. The graph executor passes its own, shorter deadline, because it
 * already fails an attempt that waits longer than that.
 */
export const START_NAMING_TTL_MS = 5 * 60_000;

/** What a consumer is told once its start is named, or `null` at the deadline. */
export type OnNamed = (ref: SessionRef | null) => void | Promise<void>;

export interface StartNaming {
  /**
   * Waits for a start's naming, and calls `onNamed` once: with the session,
   * or with `null` when the deadline passes first. The returned function
   * stops waiting without a call; calling it twice, or from inside `onNamed`,
   * is safe.
   *
   * Call `claim` first: a naming that has already arrived is not handed to a
   * later `expect`.
   */
  expect(startId: StartId, storeId: StoreId, onNamed: OnNamed): () => void;
  /**
   * Takes the start tags one server reported for one store. A tag some start
   * is waiting on is handed to it; any other is held for a later `claim`.
   *
   * Every entry is settled before this returns; the promise is the callbacks'
   * own work, so that a caller that writes a row on a naming can await it.
   */
  named(storeId: StoreId, tags: readonly SessionStartTag[]): Promise<void>;
  /**
   * The session a start was named as before it asked, once, or `null` when
   * none is held or the one held is under another store.
   */
  claim(startId: StartId, storeId: StoreId): SessionRef | null;
}

export interface StartNamingDependencies {
  readonly timers: Timers;
  /** The consumer's own logger, so a refusal is logged under the part that made the start. */
  readonly logger: Logger;
  readonly ttlMs?: number;
}

interface Held {
  ref: SessionRef;
  readonly cancel: () => void;
}

interface Expected {
  readonly storeId: StoreId;
  readonly onNamed: OnNamed;
  readonly cancel: () => void;
}

export function createStartNaming({
  timers,
  logger,
  ttlMs = START_NAMING_TTL_MS,
}: StartNamingDependencies): StartNaming {
  /** Namings that arrived before their start asked. */
  const held = new Map<StartId, Held>();
  /** Starts that asked before they were named. */
  const expected = new Map<StartId, Expected>();

  const sameStore = (startId: StartId, asked: StoreId, reported: SessionRef): boolean => {
    if (asked === reported.storeId) return true;
    logger.warn('a start was reported under a store it was not made for', {
      startId,
      asked,
      reported: reported.storeId,
    });
    return false;
  };

  /**
   * Removes an expectation if it is still the one filed, and cancels its
   * timer. Done before any callback runs, because a callback may call its own
   * disposer -- which must then find nothing left to do.
   */
  const settle = (startId: StartId, entry: Expected): boolean => {
    if (expected.get(startId) !== entry) return false;
    expected.delete(startId);
    entry.cancel();
    return true;
  };

  return {
    expect(startId: StartId, storeId: StoreId, onNamed: OnNamed): () => void {
      const previous = expected.get(startId);
      if (previous !== undefined) settle(startId, previous);

      const entry: Expected = {
        storeId,
        onNamed,
        cancel: timers.schedule(ttlMs, () => {
          if (settle(startId, entry)) void onNamed(null);
        }),
      };
      expected.set(startId, entry);
      return () => void settle(startId, entry);
    },

    async named(storeId: StoreId, tags: readonly SessionStartTag[]): Promise<void> {
      const callbacks: (void | Promise<void>)[] = [];
      for (const tag of tags) {
        if (tag.sessionId === null) continue;
        const ref: SessionRef = { storeId, sessionId: tag.sessionId };
        const startId = tag.startId;

        const waiting = expected.get(startId);
        if (waiting !== undefined) {
          if (!sameStore(startId, waiting.storeId, ref)) continue;
          settle(startId, waiting);
          callbacks.push(waiting.onNamed(ref));
          continue;
        }

        // Nobody has asked yet: the start's answer is still on its way, or
        // this was not a start this consumer cares about. A naming reported
        // again keeps the deadline it was first given, so a scan that repeats
        // a tag never arms a second timer for it.
        const already = held.get(startId);
        if (already !== undefined) {
          already.ref = ref;
          continue;
        }
        held.set(startId, {
          ref,
          cancel: timers.schedule(ttlMs, () => void held.delete(startId)),
        });
      }
      await Promise.all(callbacks);
    },

    claim(startId: StartId, storeId: StoreId): SessionRef | null {
      const already = held.get(startId);
      if (already === undefined) return null;
      held.delete(startId);
      already.cancel();
      return sameStore(startId, storeId, already.ref) ? already.ref : null;
    },
  };
}
