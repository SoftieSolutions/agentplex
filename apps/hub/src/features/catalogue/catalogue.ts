import type {
  Layout,
  NodeId,
  RefusalCode,
  SessionDescriptor,
  SessionHolder,
  SessionId,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';
import type { Projects } from '../projects/projects.js';
import { discoverNodes, type SessionPlacements } from './discovery.js';
import { createTreeMutations } from './mutations.js';
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
  /**
   * Where the session ran, as its own transcript recorded it, or `null` when
   * the provider records none.
   *
   * Carried because it is what decides the node's place: a session whose `cwd`
   * is a project's directory belongs in that project. It is a claim off another
   * machine's disk and is treated as one -- the only thing done with it here is
   * an equality against a directory a person chose by browsing.
   */
  readonly cwd: string | null;
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

/**
 * The server running one session right now, and whether it may be stopped, or
 * `null` when nobody is running it.
 *
 * A seam for the reason `StoreReader` is one, and read at the moment a removal
 * is decided rather than held: which machine has the process is a claim about
 * this second, and the tree is the one part of the hub that is durable. A copy
 * of it kept beside the rows would be a second answer waiting to differ from
 * the reducer's, and the reducer's is the one the client is looking at.
 */
export type HolderReader = (ref: SessionRef) => SessionHolder | null;

/** A folder the user asked for: where it goes, and what it is called. */
export interface NewFolderRequest {
  /** `null` is the root, which is not a node. */
  readonly parentId: NodeId | null;
  readonly name: string;
}

/** Where a node is being put: under which parent, and where among its children. */
export interface NodePlacementRequest {
  readonly parentId: NodeId | null;
  /** Clamped to the siblings there actually are. See `writes.ts` for why. */
  readonly position: number;
}

/**
 * Why the tree would not do that, in the terms a client is answered in.
 *
 * `holder` is the one field that leads somewhere: a removal refused because a
 * session is still running names the machine running it, so the client can
 * offer the stop rather than only the sentence. Every other refusal carries
 * `null`, so that a reader never has to remember which kinds carry one.
 */
export interface TreeRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly problem: string;
  readonly holder: SessionHolder | null;
}

/** A node was made, and this is the id nothing else could have told the client. */
export type NodeCreated = { readonly ok: true; readonly nodeId: NodeId } | TreeRefusal;

/** The tree changed. Nothing to carry: the client asks for the layout it wants. */
export type TreeChanged = { readonly ok: true } | TreeRefusal;

/**
 * The tree as a client edits it.
 *
 * Five acts and no more, which is the whole of what a client may do to the
 * arrangement: make a container, name a node, move one, take one out, and undo
 * the taking out. Nothing here starts, stops or deletes anything on a machine
 * -- a tree is a screen, and the things it points at live on disks the hub
 * does not own.
 */
export interface TreeMutations {
  createFolder(request: NewFolderRequest): Promise<NodeCreated>;
  /** Names a node, permanently: discovery stops following the title. */
  rename(nodeId: NodeId, name: string): Promise<TreeChanged>;
  move(nodeId: NodeId, placement: NodePlacementRequest): Promise<TreeChanged>;
  /** Refused while a session in the subtree has a live holder. */
  remove(nodeId: NodeId): Promise<TreeChanged>;
  /** Lets discovery place that session again, and runs a pass so it does. */
  forgetRemoval(ref: SessionRef): Promise<TreeChanged>;
}

/**
 * What the client broadcast needs of this feature: the edits, and word that the
 * tree changed.
 *
 * Narrower than `Catalogue` on purpose. The broadcast does not read the layout
 * through this -- that is a per-client reply and arrives as its own function --
 * and it has no business being handed the report seam a server's scan drives.
 */
export interface ClientCatalogue extends TreeMutations {
  /**
   * Told after every change to the tree, with the version it is now at.
   *
   * A version and not the nodes, because what has to reach every client is the
   * fact that what it holds is old, and what a client should then read depends
   * on what it is drawing. Answers a function that stops the listening.
   */
  subscribe(listener: (version: number) => void): () => void;
}

export interface CatalogueDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readStore: StoreReader;
  /**
   * Which project a directory is, if any.
   *
   * The whole of what the tree needs from projects, and deliberately only the
   * read: this feature places a session inside a project and never makes,
   * renames or removes one. The edge runs one way -- the catalogue reads
   * projects, projects reads nothing here -- which is what keeps two features
   * writing `nodes` from being two features writing each other.
   */
  readonly projects: Pick<Projects, 'findByDirectory'>;
  /**
   * Who is running a session right now, read when a removal is decided.
   *
   * The tree holds no such fact and must not: a node points at a session only a
   * server's next scan can confirm, and a column saying "running" would be a
   * durable row making a claim about a process the hub may have lost the route
   * to. So the question is asked, at the moment it is answered.
   */
  readonly readHolder: HolderReader;
}

export interface Catalogue extends ClientCatalogue {
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
  /**
   * Says the tree changed under another writer's hand.
   *
   * The projects feature writes `nodes`, because a project is one row here and
   * one row there and splitting that insert across a feature boundary would
   * mean a transaction neither feature owns (see `project-rows.ts`). The
   * version, though, is one number for the tree, and a version only one of its
   * two writers bumped is a version that means nothing after the other wrote.
   * So the other writer says so, and this is where it says it.
   */
  changed(): void;
}

export function createCatalogue({
  database,
  ids,
  clock,
  logger,
  readStore,
  projects,
  readHolder,
}: CatalogueDependencies): Catalogue {
  const log = logger.child({ part: 'catalogue' });

  /**
   * How many times this tree has changed since the hub started.
   *
   * In memory and not a row, which is the decision worth stating. It counts
   * changes a client may have missed *on this hub run*, and a client that was
   * not attached for a restart has already been sent a whole state and will
   * ask for a whole layout on its next hello. Persisting it would be storing a
   * number whose only reader is a connection that cannot outlive the process.
   */
  let version = 0;
  const watchers = new Set<(version: number) => void>();

  /**
   * Bumps the version and tells everybody watching.
   *
   * A listener that throws costs itself and not the others, for the reason the
   * broadcast applies to its sockets: one closed tab must not stop the rest of
   * the fleet being told.
   */
  const changed = (): void => {
    version += 1;
    for (const watcher of [...watchers]) {
      try {
        watcher(version);
      } catch (error) {
        log.warn('a catalogue watcher threw', { problem: String(error) });
      }
    }
  };

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

    // Resolved before the transaction opens rather than inside it. The lookup
    // belongs to another feature, which holds the database rather than this
    // transaction's handle, and a feature reaching into a transaction it was
    // not given is how two owners of one connection start to matter.
    //
    // What that costs is a window: a project removed between this and the
    // insert below leaves a parent that is gone, the foreign key refuses the
    // row, and the whole pass for this store is logged and dropped. The next
    // report brings another whole reading, so it is a stale tree for a few
    // seconds and never a wrong one -- the same bargain the catch below
    // already makes.
    const placements = await placementsFor(sessions);

    try {
      // One transaction for the pair. A reading is one reading, and a tree with
      // the placements committed and the sweep not is a tree that agrees with
      // no reading that ever happened.
      const outcome = await database.transaction((tx) =>
        bringInLine(tx, storeId, sessions, placements),
      );
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
        // Announced for the same reason a rename is. The frame names the
        // catalogue, not the client's own edit: a tree that quietly fell behind
        // the fleet is the same stale screen as one that fell behind a rename,
        // and the client that is drawing it cannot tell which happened.
        changed();
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

  /**
   * The project each of these sessions belongs in, for the ones that belong in
   * any.
   *
   * A session with no `cwd` is a session the provider never said where it ran,
   * and the honest answer is the root: a guess at the store's own directory
   * would file sessions under a project nobody started them in.
   *
   * Absent from the map is the root, which is why this is a map of the ones
   * that matched rather than one entry per session.
   */
  const placementsFor = async (
    sessions: readonly SessionDescriptor[],
  ): Promise<SessionPlacements> => {
    const placements = new Map<SessionId, NodeId>();
    for (const descriptor of sessions) {
      if (descriptor.cwd === null) continue;
      const project = await projects.findByDirectory(descriptor.cwd);
      if (project !== null) placements.set(descriptor.sessionId, project);
    }
    return placements;
  };

  const bringInLine = async (
    tx: Queryable,
    storeId: StoreId,
    sessions: readonly SessionDescriptor[],
    placements: SessionPlacements,
  ): Promise<DiscoveryOutcome & PruneOutcome> => {
    // Filed under the store that was read and never under the descriptor's own
    // claim, for the reason the reducer files a row that way: a descriptor
    // naming another store is that row disagreeing with the reading it arrived
    // in, and following it would let one volume place nodes in another.
    const found = sessions.map((descriptor) => ({
      ref: { storeId, sessionId: descriptor.sessionId },
      title: descriptor.title,
      cwd: descriptor.cwd,
    }));
    const discovered = await discoverNodes(tx, ids, clock, found, placements);
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

  const observe = (storeId: StoreId): Promise<void> => {
    reached.add(storeId);
    // No `catch` and no `finally`: `follow` swallows its own failure, so this
    // cannot reject and there is nothing here for a rejection to escape from.
    catchingUp ??= catchUp();
    return catchingUp;
  };

  // Built on this entry's own seams rather than given the dependencies twice:
  // `observe` above is the one a forgotten removal runs, and `changed` is the
  // one number every writer of this tree bumps.
  const mutations = createTreeMutations({
    database,
    ids,
    clock,
    readHolder,
    observe,
    changed,
    logger,
  });

  return {
    ...mutations,

    readLayout: () => readLayout(database),

    observe,

    changed,

    subscribe(listener: (version: number) => void): () => void {
      watchers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        watchers.delete(listener);
      };
    },
  };
}
