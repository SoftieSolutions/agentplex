import type {
  Layout,
  SessionDescriptor,
  SessionId,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';
import { discoverNodes } from './discovery.js';
import { pruneNodes } from './prune.js';
import { readLayout } from './reads.js';
import type { TreeNode } from './rows.js';

/**
 * The catalogue: the user's arrangement of their sessions, as a tree.
 *
 * The feature owns `nodes`, `node_kinds` and `node_removals`, and the three
 * writers that touch them -- the user (`writes.ts`), discovery (`discovery.ts`)
 * and the prune sweep (`prune.ts`). `rows.ts` says what a row is and argues
 * the rule the writers share: the user wins and keeps winning.
 *
 * `observe` is where the second and third of those writers are driven from, and
 * before AGX-90 nothing drove them: a live hub answered every layout request
 * with an empty tree, confidently, whatever was actually on the machines. The
 * whole of what this entry adds is the join between a store having been read
 * and the tree following what was read.
 */

/** One session a scan found, and what its transcript calls it. */
export interface DiscoveredSession {
  readonly ref: SessionRef;
  /** The provider's title, or `null` when it names its sessions nothing. */
  readonly title: string | null;
}

export interface DiscoveryOutcome {
  /** Nodes placed for sessions that had none. */
  readonly created: readonly TreeNode[];
  /** Nodes whose name followed a changed transcript title. */
  readonly retitled: readonly TreeNode[];
  /**
   * Sessions the hub declined to place because their removal is remembered.
   *
   * Reported rather than silent: it is the count that tells an operator the
   * difference between "discovery found nothing" and "discovery found things it
   * has been told not to show".
   */
  readonly suppressed: readonly SessionRef[];
}

/**
 * One store a server actually reached, and everything it saw in it.
 *
 * Reached is the load-bearing word, and it is the caller's to establish: the
 * prune takes the stores whose sessions were genuinely enumerated, not every
 * store the hub has heard of. Handing it an unreachable store's last-known --
 * or empty -- session list is how the sweep's safeguard gets spent by its
 * caller.
 */
export interface StoreScan {
  readonly storeId: StoreId;
  /**
   * Every session that store holds, whole. Never a delta: what is absent from
   * this list is what the sweep will act on.
   */
  readonly sessions: readonly SessionId[];
}

export interface PruneOutcome {
  /** Nodes whose sessions a reached store no longer has. */
  readonly pruned: readonly SessionRef[];
  /**
   * Remembered removals dropped because their session is gone too.
   *
   * A removal exists to stop discovery re-creating a node. Once the session
   * itself is gone there is nothing left for it to suppress, and a memory that
   * can never be consulted again is a row that grows without bound and answers
   * no question.
   */
  readonly forgotten: readonly SessionRef[];
}

/**
 * What the hub currently believes one store holds, whole, or `null` when it
 * knows of no such store.
 *
 * A seam rather than a list handed to `observe`, and the difference is the
 * decision this feature makes about what it may prune against.
 *
 * A store report arrives from one server, but a store can be mounted on
 * several, and what the hub believes is in it is the reducer's merge of every
 * server attached to it. Pruning against the one server whose report happened
 * to arrive would delete the nodes of every session that server had not got to
 * yet -- and the next report from its neighbour would put them back, at the end
 * of the root, in front of a user who moved nothing. Worse, the tree would then
 * disagree with the session list on the same screen, which is assembled from
 * the merge. So the reading is asked for rather than carried, and it is asked
 * for at the moment the tree is actually written: a reading is whole, so the
 * freshest one is the only one worth having.
 */
export type StoreReader = (storeId: StoreId) => readonly SessionDescriptor[] | null;

export interface CatalogueDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readStore: StoreReader;
}

export interface Catalogue {
  /**
   * The tree as a client reads it, ordered parents-first. Read per request
   * rather than held beside the fleet state: where the user put things
   * survives a restart, and which sessions are reachable this second does not.
   */
  readLayout(): Promise<Layout>;
  /**
   * Takes the news that a store was just read, and brings the tree into line
   * with what the hub now believes is in it.
   *
   * The argument is a store and not a report, because being told is the
   * evidence and the reading is looked up: a store nobody reached is a store
   * `observe` is never called for, which is exactly the precondition the sweep
   * in `prune.ts` is written against.
   *
   * Answers when the tree has caught up, which is what a test awaits. The hub
   * does not await it, and nothing on the frame path may: the reply to a
   * server's report is the fleet state and the broadcast, and a tree write is
   * behind both.
   *
   * It never rejects. A tree the database would not let the hub update costs
   * that store's update and nothing else -- not the fleet state, not the
   * broadcast, and not the next store's turn.
   */
  observe(storeId: StoreId): Promise<void>;
}

export function createCatalogue({
  database,
  ids,
  clock,
  logger,
  readStore,
}: CatalogueDependencies): Catalogue {
  const log = logger.child({ part: 'catalogue' });

  /**
   * The stores that have been read since the tree last caught up with them.
   *
   * A set of stores and not a queue of readings, which is the coalescing the
   * ticket asks for made structural rather than remembered. Servers report on a
   * schedule and a shared volume is reported by every server that has it
   * mounted, so readings arrive faster than a synchronous SQLite writer
   * finishes: a queue would grow one entry per report and then apply each in
   * turn, spending N transactions to arrive at what the last one says. A
   * reading is whole, so every entry but the last is already known to be
   * superseded. What is kept is therefore the fact that a store needs looking
   * at, once per store, and the reading itself is taken from `readStore` at the
   * moment the write actually runs.
   */
  const reached = new Set<StoreId>();
  /** The pass in flight, or `null` when the tree is caught up. */
  let catchingUp: Promise<void> | null = null;

  /** One store, in one transaction, with its failure costing only itself. */
  const follow = async (storeId: StoreId): Promise<void> => {
    const sessions = readStore(storeId);
    if (sessions === null) {
      // The store went away between the report and this turn -- its last server
      // was revoked, or unmounted the volume. There is no reading, so there is
      // nothing this may prune against.
      log.debug('a store was read and is already gone; the tree is left alone', { storeId });
      return;
    }

    try {
      // One transaction for the pair. A reading is one reading, and a tree with
      // the placements committed and the sweep not is a tree that agrees with
      // no reading that ever happened.
      const outcome = await database.transaction((tx) => bringInLine(tx, storeId, sessions));
      const counts = {
        created: outcome.created.length,
        retitled: outcome.retitled.length,
        pruned: outcome.pruned.length,
        suppressed: outcome.suppressed.length,
        forgotten: outcome.forgotten.length,
      };
      // A scan that changed nothing is the common case -- a store nobody
      // touched between two reports -- and a line per report per store would
      // bury the ones that did something.
      if (Object.values(counts).some((count) => count > 0)) {
        log.info('the tree followed a store', { storeId, ...counts });
      }
    } catch (error) {
      // Logged and dropped. The next report of this store brings another whole
      // reading, so a lost update costs a stale tree until then and never a
      // wrong one -- and the state the client is looking at was published
      // before this ran.
      log.warn('the tree could not be brought into line with a store', {
        storeId,
        problem: String(error),
      });
    }
  };

  const bringInLine = async (
    tx: Queryable,
    storeId: StoreId,
    sessions: readonly SessionDescriptor[],
  ): Promise<DiscoveryOutcome & PruneOutcome> => {
    // Filed under the store that was read and never under the descriptor's own
    // claim, for the reason the reducer files a row that way: a descriptor
    // naming another store is that row disagreeing with the reading it arrived
    // in, and following it would let one volume place nodes in another.
    const found = sessions.map((descriptor) => ({
      ref: { storeId, sessionId: descriptor.sessionId },
      title: descriptor.title,
    }));
    const discovered = await discoverNodes(tx, ids, clock, found);
    const swept = await pruneNodes(tx, [
      { storeId, sessions: found.map((session) => session.ref.sessionId) },
    ]);
    return { ...discovered, ...swept };
  };

  const catchUp = async (): Promise<void> => {
    // Nothing touches the database on the caller's stack. A report is applied
    // to the fleet state and broadcast on the turn it arrived on, and the tree
    // write is what happens after that, not before it.
    await Promise.resolve();
    while (true) {
      const next = reached.values().next();
      if (next.done === true) {
        // Cleared here, at the moment this pass decides it has nothing left,
        // rather than when its promise settles. Between those two is a window
        // in which a store marked for a pass would attach to one that is
        // already finished, and wait for a report that may never come.
        catchingUp = null;
        return;
      }
      // Taken out before the write rather than after, so that a report arriving
      // while this store is being written marks it again and earns another
      // pass. Clearing it afterwards would swallow that reading.
      reached.delete(next.value);
      await follow(next.value);
    }
  };

  return {
    readLayout: () => readLayout(database),

    observe(storeId: StoreId): Promise<void> {
      reached.add(storeId);
      // No `catch` and no `finally`: `follow` swallows its own failure, so this
      // cannot reject and there is nothing here for a rejection to escape from.
      catchingUp ??= catchUp();
      return catchingUp;
    },
  };
}
