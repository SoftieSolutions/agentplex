import type { NodeId, SessionHolder, SessionRef, StoreId } from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';
import type {
  HolderReader,
  NewFolderRequest,
  NodeCreated,
  NodePlacementRequest,
  TreeChanged,
  TreeMutations,
  TreeRefusal,
} from './catalogue.js';
import { findNode, findNodeKind, listAncestry, listSubtree } from './reads.js';
import { PROJECT_KIND, type TreeNode } from './rows.js';
import {
  createFolder,
  forgetRemoval,
  moveNode,
  removeNode,
  renameNode,
  wouldCycle,
} from './writes.js';

/**
 * The tree as a client edits it: the five mutations, and every reason one is
 * answered with a sentence instead.
 *
 * This is the layer between `writes.ts` and the socket, and the split is what
 * it is for. The writes are a data layer: a caller that asks a session to hold
 * children has a bug, and it gets a throw. A person who dropped a folder onto
 * a session card has a situation, and what they are owed is a sentence they can
 * act on. So every rule the writes state as a throw is asked here first, as a
 * question, and the throw stays where it is as the last word against a caller
 * that never came through this file.
 *
 * The cost of asking first is a window: the parent checked here can be gone by
 * the time the write runs, and then the throw does escape and the client is
 * told the hub broke. That is the same bargain `catalogue.ts` makes when it
 * resolves a project before opening its transaction, and it resolves the same
 * way -- the tree is stale for as long as it takes to ask again, and never
 * wrong.
 *
 * ## What a removal does not do
 *
 * It does not reach a server, and there is no code path here that could. A tree
 * is the user's arrangement of their own screen; the transcript on the disk is
 * what a session *is*, and removing a card from an arrangement has never meant
 * deleting the thing the card was about. What a removal does instead is
 * remember, so that discovery does not undo it on the next scan.
 *
 * The one refusal that is about the world rather than about the tree is the
 * live holder, and it exists because the alternative over-claims in the
 * direction that costs most: a session removed while its process runs is a
 * process still going with nothing on any screen pointing at it. The refusal
 * names the holder so the client can offer the stop that clears the way, which
 * is the same reason a start's refusal names one.
 */

export interface MutationDependencies {
  readonly database: Database;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Who is running a session right now. The one fact the tree cannot hold. */
  readonly readHolder: HolderReader;
  /**
   * Brings the tree into line with a store, now.
   *
   * Only `forgetRemoval` uses it, and it is the difference between "this
   * session will come back" and "this session is back": discovery would place
   * it on the next report anyway, and a person who has just asked for it
   * should not be watching an empty space until a server's timer comes round.
   */
  readonly observe: (storeId: StoreId) => Promise<void>;
  /** Says the tree changed, so every attached client can be told. */
  readonly changed: () => void;
  readonly logger: Logger;
}

export function createTreeMutations({
  database,
  ids,
  clock,
  readHolder,
  observe,
  changed,
  logger,
}: MutationDependencies): TreeMutations {
  const log = logger.child({ part: 'tree' });

  return {
    async createFolder(request: NewFolderRequest): Promise<NodeCreated> {
      const name = request.name.trim();
      if (name === '') return refused('a folder needs a name');
      const barrier = await notAContainer(database, request.parentId);
      if (barrier !== null) return barrier;

      const folder = await createFolder(database, ids, clock, {
        parentId: request.parentId,
        name,
      });
      log.info('folder created', { nodeId: folder.id, parentId: request.parentId });
      changed();
      return { ok: true, nodeId: folder.id };
    },

    async rename(nodeId: NodeId, name: string): Promise<TreeChanged> {
      const trimmed = name.trim();
      // Blank rather than unparseable, for the reason `layout.ts` argues at
      // length: a name of spaces is a thing to say to a person, and refusing
      // the frame would be hanging up on them instead.
      if (trimmed === '') return refused('a node needs a name');

      const renamed = await renameNode(database, nodeId, trimmed);
      if (renamed === null) return refused(NO_SUCH_NODE);
      changed();
      return { ok: true };
    },

    async move(nodeId: NodeId, placement: NodePlacementRequest): Promise<TreeChanged> {
      const node = await findNode(database, nodeId);
      if (node === null) return refused(NO_SUCH_NODE);

      const barrier = await notAContainer(database, placement.parentId);
      if (barrier !== null) return barrier;
      if (await wouldCycle(database, nodeId, placement.parentId)) {
        return refused('a node cannot be moved inside itself');
      }
      const nested = await nestedProject(database, node, placement.parentId);
      if (nested !== null) return nested;

      await moveNode(database, nodeId, placement);
      changed();
      return { ok: true };
    },

    async remove(nodeId: NodeId): Promise<TreeChanged> {
      const node = await findNode(database, nodeId);
      if (node === null) return refused(NO_SUCH_NODE);

      // Read before the write and not inside it, because the answer comes from
      // the fleet state rather than from this transaction: which machine is
      // running something is a claim about now, and the only thing that knows
      // is the thing holding the socket.
      const running = await liveHolder(database, node, readHolder);
      if (running !== null) {
        log.info('removal refused', { nodeId, sessionId: running.ref.sessionId });
        const itself = node.anchor !== null && node.anchor.sessionId === running.ref.sessionId;
        return refused(
          itself
            ? 'this session is still running; stop it first, and then remove it'
            : `the session ${running.ref.sessionId} inside is still running; ` +
                'stop it first, and then remove it',
          running.holder,
        );
      }

      const removed = await removeNode(database, clock, nodeId);
      // Gone between the read above and the delete. Nothing was removed and
      // nothing was remembered, which is what this says.
      if (removed.node === null) return refused(NO_SUCH_NODE);
      log.info('node removed', { nodeId, remembered: removed.remembered.length });
      changed();
      return { ok: true };
    },

    async forgetRemoval(ref: SessionRef): Promise<TreeChanged> {
      const forgotten = await forgetRemoval(database, ref);
      if (!forgotten) return refused('this hub remembers no removal of that session');
      log.info('removal forgotten', { storeId: ref.storeId, sessionId: ref.sessionId });

      // Awaited, and nothing is announced here. The forgetting on its own
      // changes no node, so there is nothing for a client holding a layout to
      // re-read; what changes the tree is the pass this runs, and that
      // announces itself. A store no server has mounted places nothing and
      // says nothing, which is the honest answer: the session comes back when
      // the machine holding it does.
      await observe(ref.storeId);
      return { ok: true };
    },
  };
}

/**
 * One sentence for the three acts that can be aimed at a node that is not
 * there, because it is one situation: a client describing a tree that has
 * moved on. It reads the same whichever of them asked.
 */
const NO_SUCH_NODE = 'this hub has no node by that id';

/**
 * Every no here is `refused` and never `internal`, and the difference is what
 * the client does next: `refused` says the hub understood and declined, which
 * invites nothing, and `internal` says it broke and retrying may work. None of
 * these gets better on a second try.
 */
function refused(problem: string, holder: SessionHolder | null = null): TreeRefusal {
  return { ok: false, code: 'refused', problem, holder };
}

/**
 * Why that parent cannot hold this, or `null` when it can.
 *
 * `null` is the root, which always can: it is not a node, so there is nothing
 * to ask about it. Everything else is asked of `node_kinds`, which is where
 * migration 0004 put the answer -- a CHECK cannot consult another table's row,
 * so the schema states the fact and this is one of the two places that applies
 * it.
 */
async function notAContainer(
  database: Queryable,
  parentId: NodeId | null,
): Promise<TreeRefusal | null> {
  if (parentId === null) return null;
  const parent = await findNode(database, parentId);
  if (parent === null) return refused('this hub has no node by that id to put it under');
  const kind = await findNodeKind(database, parent.kind);
  if (kind === null || !kind.container) {
    return refused(`a ${String(parent.kind)} holds no children, so nothing can go inside it`);
  }
  return null;
}

/**
 * Why this move would nest a project, or `null` when it would not.
 *
 * Asked of the subtree and the ancestry rather than of the two nodes, because
 * the rule is about where a project ends up and not about what was dragged: a
 * folder with a project in it, dropped on a project, nests one just as surely.
 */
async function nestedProject(
  database: Queryable,
  node: TreeNode,
  parentId: NodeId | null,
): Promise<TreeRefusal | null> {
  if (parentId === null) return null;
  const moving = await listSubtree(database, node);
  if (!moving.some((member) => member.kind === PROJECT_KIND)) return null;
  const above = await listAncestry(database, parentId);
  if (!above.some((ancestor) => ancestor.kind === PROJECT_KIND)) return null;
  return refused(
    'a project cannot go inside another project: a session is filed under the project ' +
      'whose directory it ran in, and that has to be a definite one of them',
  );
}

/**
 * The first session in this subtree somebody is running, or `null`.
 *
 * The first and not all of them: one is enough to refuse, the client is offered
 * one stop at a time, and a list of holders would be a list whose second entry
 * is stale by the time anybody acts on it.
 */
async function liveHolder(
  database: Queryable,
  node: TreeNode,
  readHolder: HolderReader,
): Promise<{ readonly ref: SessionRef; readonly holder: SessionHolder } | null> {
  for (const member of await listSubtree(database, node)) {
    if (member.anchor === null) continue;
    const holder = readHolder(member.anchor);
    if (holder !== null) return { ref: member.anchor, holder };
  }
  return null;
}
