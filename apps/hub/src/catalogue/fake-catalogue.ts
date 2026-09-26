import {
  nodeIdSchema,
  type CatalogueQuery,
  type Layout,
  type NodeId,
  type SessionRef,
} from '@agentplex/protocol';
import type {
  Catalogue,
  NewFolderRequest,
  NodeCreated,
  NodePlacementRequest,
  SessionProjectReading,
  TreeChanged,
  TreeRefusal,
} from './catalogue.js';
import type { SessionProject } from '../fleet-state/fleet-state.js';
import type { CataloguePageOutcome } from './query.js';

/**
 * The catalogue, driven by hand.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-projects.ts` is one: what a client connection has to get right is what
 * it does with an outcome -- an id for a folder it made, a refusal naming the
 * machine still running a session, a version that has to reach every attached
 * socket -- and each of those is a value this hands back. The tree itself is
 * the catalogue suites' subject, and it is tested against a migrated schema
 * where it lives.
 *
 * Every mutation records what it was asked and answers whatever `refuseWith`
 * was last given, or yes. One switch for all five rather than one setter each,
 * because a suite about the socket cares which act was asked for and not how
 * each one is spelled.
 */
export interface FakeCatalogue extends Catalogue {
  /** Every mutation asked for, in order, as one word plus what it carried. */
  readonly asked: readonly FakeMutation[];
  /** What every later mutation answers with. `null` puts it back to yes. */
  refuseWith(refusal: TreeRefusal | null): void;
  /**
   * Makes every later mutation reject, as a database that would not commit
   * does. `null` puts it back.
   *
   * A refusal and a throw are two different answers and a suite has to be able
   * to drive both: one is the hub understanding and declining, the other is
   * the hub breaking, and the client is told different things.
   */
  failWith(error: Error | null): void;
  /** What every later layout request answers with. */
  answerWith(layout: Layout): void;
  /** Every query asked for, in order, so a suite can assert on what crossed. */
  readonly queried: readonly CatalogueQuery[];
  /** What every later query answers with. */
  answerPageWith(outcome: CataloguePageOutcome): void;
  /**
   * What every later reading of where sessions sit answers with, keyed by the
   * fleet state's `sessionKey`.
   *
   * The version on that reading is this fake's own, for the reason the real
   * one carries it: a reader drops a reading older than the one it applied,
   * and a fake that answered a constant would be a seam that cannot show the
   * drop happening. `followSessionProjects` hands on the same map.
   */
  answerProjectsWith(placements: ReadonlyMap<string, SessionProject>): void;
  /** Bumps the version and tells every watcher, as a real change would. */
  change(): void;
  /** The version this fake is at. */
  readonly version: number;
}

export type FakeMutation =
  | { readonly act: 'create-folder'; readonly request: NewFolderRequest }
  | { readonly act: 'rename'; readonly nodeId: NodeId; readonly name: string }
  | { readonly act: 'move'; readonly nodeId: NodeId; readonly placement: NodePlacementRequest }
  | { readonly act: 'remove'; readonly nodeId: NodeId }
  | { readonly act: 'forget-removal'; readonly ref: SessionRef };

export interface FakeCatalogueOptions {
  readonly layout?: Layout;
}

export function createFakeCatalogue(options: FakeCatalogueOptions = {}): FakeCatalogue {
  const asked: FakeMutation[] = [];
  const queried: CatalogueQuery[] = [];
  const watchers = new Set<(version: number) => void>();
  let layout: Layout = options.layout ?? [];
  let refusal: TreeRefusal | null = null;
  let failure: Error | null = null;
  let version = 0;
  let minted = 0;
  let page: CataloguePageOutcome = { ok: true, items: [], nextCursor: null, total: 0, version: 0 };
  let placements: ReadonlyMap<string, SessionProject> = new Map();

  const subscribe = (listener: (version: number) => void): (() => void) => {
    watchers.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      watchers.delete(listener);
    };
  };

  const bump = (): void => {
    version += 1;
    for (const watcher of [...watchers]) watcher(version);
  };

  const record = (mutation: FakeMutation): TreeChanged => {
    asked.push(mutation);
    if (failure !== null) throw failure;
    if (refusal !== null) return refusal;
    bump();
    return { ok: true };
  };

  return {
    async readLayout(): Promise<Layout> {
      return layout;
    },

    async projectOf(): Promise<null> {
      // No tree here, so nothing is filed anywhere. `null` is the honest
      // answer and it is the one that makes every request reach a person,
      // which is what the suites using this fake are about.
      return null;
    },

    async query(request: CatalogueQuery): Promise<CataloguePageOutcome> {
      queried.push(request);
      if (failure !== null) throw failure;
      return page;
    },

    async observe(): Promise<void> {
      // A fake reaches no store and scans nothing. What `observe` means to a
      // caller here is only that it settles.
    },

    async sessionProjects(): Promise<SessionProjectReading> {
      return { version, placements };
    },

    changed: bump,

    subscribe,

    followSessionProjects(
      listener: (placements: ReadonlyMap<string, SessionProject>) => void,
    ): () => void {
      // Once now and once per change, and on the caller's stack rather than
      // coalesced: a suite about the socket drives each change by hand, and
      // what it asserts is what was handed on, not how many reads it cost.
      // The coalescing is the real catalogue's, tested where it lives.
      const stop = subscribe(() => listener(placements));
      listener(placements);
      return stop;
    },

    async createFolder(request: NewFolderRequest): Promise<NodeCreated> {
      asked.push({ act: 'create-folder', request });
      if (failure !== null) throw failure;
      if (refusal !== null) return refusal;
      bump();
      return { ok: true, nodeId: nodeIdSchema.parse(`folder-${String((minted += 1))}`) };
    },

    async rename(nodeId: NodeId, name: string): Promise<TreeChanged> {
      return record({ act: 'rename', nodeId, name });
    },

    async move(nodeId: NodeId, placement: NodePlacementRequest): Promise<TreeChanged> {
      return record({ act: 'move', nodeId, placement });
    },

    async remove(nodeId: NodeId): Promise<TreeChanged> {
      return record({ act: 'remove', nodeId });
    },

    async forgetRemoval(ref: SessionRef): Promise<TreeChanged> {
      return record({ act: 'forget-removal', ref });
    },

    refuseWith(next: TreeRefusal | null): void {
      refusal = next;
    },

    failWith(next: Error | null): void {
      failure = next;
    },

    answerWith(next: Layout): void {
      layout = next;
    },

    answerPageWith(next: CataloguePageOutcome): void {
      page = next;
    },

    answerProjectsWith(next: ReadonlyMap<string, SessionProject>): void {
      placements = next;
    },

    change: bump,

    get asked(): readonly FakeMutation[] {
      return asked;
    },

    get queried(): readonly CatalogueQuery[] {
      return queried;
    },

    get version(): number {
      return version;
    },
  };
}
