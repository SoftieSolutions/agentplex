import type { Layout, SessionId, SessionRef, StoreId } from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
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
 * Two of the three methods below are wired to nothing yet. Discovery and the
 * prune are complete against a real database and are called by no scan; the
 * ticket that joins them to what the servers report is AGX-90. They are on the
 * seam now so that the join is a call and not a design.
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

export interface CatalogueDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface Catalogue {
  /**
   * The tree as a client reads it, ordered parents-first. Read per request
   * rather than held beside the fleet state: where the user put things
   * survives a restart, and which sessions are reachable this second does not.
   */
  readLayout(): Promise<Layout>;
  /** Places what is new, retitles what still follows its title, restores nothing. */
  discover(sessions: readonly DiscoveredSession[]): Promise<DiscoveryOutcome>;
  /** Sweeps the tree against what a scan actually reached. */
  prune(scan: readonly StoreScan[]): Promise<PruneOutcome>;
}

export function createCatalogue({ database, ids, clock }: CatalogueDependencies): Catalogue {
  return {
    readLayout: () => readLayout(database),
    discover: (sessions) => discoverNodes(database, ids, clock, sessions),
    prune: (scan) => pruneNodes(database, scan),
  };
}
