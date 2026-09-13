import type {
  FrameId,
  Layout,
  LayoutNode,
  MachineState,
  NodeId,
  SessionHolder,
  SessionRef,
} from '@agentplex/protocol';
import type { HubCommand, RefusalView, TreeChangeView } from '../store/hub-store.js';
import { FOLDER_KIND, PROJECT_KIND } from './node-kinds.js';

/**
 * Every rule the tree menus follow, as functions of values.
 *
 * The components own what a person has clicked and typed; what a menu may
 * offer, what the frame carries, and what to do with the hub's answer are
 * decided here, where a test can hold a captured layout against them without a
 * DOM.
 *
 * One thing is worth reading twice, because it is a judgement rather than a
 * fact the hub sent: which nodes are offered as somewhere to put something.
 * The table saying what may hold children lives in the hub's database and is
 * not published, so this offers the two kinds it knows are containers and
 * leaves the rule where it is enforced. A client that guessed wider would be
 * offering moves that can only be refused; one that guessed narrower would
 * hide a folder somebody made. Both are worse than asking for the two kinds
 * this build can name.
 */

/** One place a node may be put: the root, a folder, or a project. */
export interface MoveTarget {
  /** `null` is the root, which is not a node and has no id. */
  readonly parentId: NodeId | null;
  readonly label: string;
}

/**
 * Where this node may go, in the order the hub sent the tree.
 *
 * Its own subtree is left out, and that is not a duplicate of the hub's cycle
 * refusal: the hub refuses because the state has no reading, and this leaves
 * them out because offering a person a move that can only be refused is an
 * option that wastes a click. Both stay -- a client one frame behind the tree
 * can still ask for one, and then the refusal is the honest answer.
 */
export function moveTargets(layout: Layout | null, nodeId: NodeId): readonly MoveTarget[] {
  const targets: MoveTarget[] = [{ parentId: null, label: 'Top level' }];
  if (layout === null) return targets;

  const inside = subtreeOf(layout, nodeId);
  for (const node of layout) {
    if (node.kind !== FOLDER_KIND && node.kind !== PROJECT_KIND) continue;
    if (inside.has(node.id)) continue;
    targets.push({ parentId: node.id, label: node.name ?? node.id });
  }
  return targets;
}

/** A node and everything under it, which is what a move may not land inside. */
function subtreeOf(layout: Layout, nodeId: NodeId): ReadonlySet<NodeId> {
  const inside = new Set<NodeId>([nodeId]);
  // The hub sends parents before children, so one pass is enough: a node's
  // parent has already been decided by the time the node is read.
  for (const node of layout) {
    if (node.parentId !== null && inside.has(node.parentId)) inside.add(node.id);
  }
  return inside;
}

/** The node pointing at one session, or `null` when the tree does not hold it. */
export function nodeForSession(layout: Layout | null, ref: SessionRef): LayoutNode | null {
  if (layout === null) return null;
  return (
    layout.find(
      (node) =>
        node.anchor !== null &&
        node.anchor.storeId === ref.storeId &&
        node.anchor.sessionId === ref.sessionId,
    ) ?? null
  );
}

/** Every project in the tree, parents first, as the rows a menu hangs off. */
export function projectNodes(layout: Layout | null): readonly LayoutNode[] {
  return (layout ?? []).filter((node) => node.kind === PROJECT_KIND);
}

/**
 * One session the fleet has that the tree does not hold.
 *
 * Derived rather than asked for, because there is no frame that lists what a
 * hub has been told to forget and there does not need to be: a removal takes
 * the node out and leaves the session exactly where it was, so a session in
 * the machine state with no node in the layout *is* the removed one.
 *
 * The wording that goes with this list has to be careful, and the list itself
 * cannot be. A session discovery has not placed yet looks the same from here,
 * which is why nothing below calls these "removed": they are sessions that are
 * not in the tree, and putting one back is a question the hub answers.
 */
export interface AbsentSession {
  readonly ref: SessionRef;
  /** The provider's title, or the session's own id when it has none. */
  readonly name: string;
  /** Stable render key. JSON, not a joined string: ids may hold any separator. */
  readonly key: string;
}

export function sessionsNotInTree(
  state: MachineState | null,
  layout: Layout | null,
): readonly AbsentSession[] {
  // `null` is "no layout has been answered yet", which is not the same as an
  // empty tree: claiming every session is missing while the first answer is in
  // flight would put the whole fleet in a list headed "not in your tree".
  if (state === null || layout === null) return [];

  const anchored = new Set(
    layout
      .filter((node) => node.anchor !== null)
      .map((node) => JSON.stringify([node.anchor?.storeId, node.anchor?.sessionId])),
  );
  const absent: AbsentSession[] = [];
  for (const store of state.stores) {
    for (const row of store.sessions) {
      const { descriptor } = row;
      const key = JSON.stringify([descriptor.storeId, descriptor.sessionId]);
      if (anchored.has(key)) continue;
      absent.push({
        ref: { storeId: descriptor.storeId, sessionId: descriptor.sessionId },
        name: descriptor.title ?? descriptor.sessionId,
        key,
      });
    }
  }
  return absent;
}

/** The five commands, each exactly the fields its frame defines. */
export function buildCreateFolder(parentId: NodeId | null, name: string): HubCommand {
  return { type: 'node-create-folder', parentId, name: name.trim() };
}

export function buildRename(nodeId: NodeId, name: string): HubCommand {
  return { type: 'node-rename', nodeId, name: name.trim() };
}

export function buildMove(nodeId: NodeId, parentId: NodeId | null): HubCommand {
  // Last among its new siblings, which is where a menu can honestly say a
  // thing goes: the menu offers a container and not an index, and inventing
  // one would be claiming the person chose it.
  return { type: 'node-move', nodeId, parentId, position: LAST };
}

/**
 * Far past the end of any tree a person arranged, which the hub clamps.
 *
 * Clamping is the hub's stated behaviour rather than an accident of this
 * number: a client that computed an index against a tree that has since
 * changed asked for something reasonable, so the position is brought to the
 * end instead of refused.
 */
const LAST = 1_000_000;

export function buildRemove(nodeId: NodeId): HubCommand {
  return { type: 'node-remove', nodeId };
}

export function buildForgetRemoval(ref: SessionRef): HubCommand {
  return { type: 'node-forget-removal', storeId: ref.storeId, sessionId: ref.sessionId };
}

export function buildStop(ref: SessionRef): HubCommand {
  return { type: 'session-stop', storeId: ref.storeId, sessionId: ref.sessionId };
}

/**
 * What the menu does with the hub's answer to the edit it sent.
 *
 * `holder` rides the refusal because it is what makes one refusal different
 * from the rest: "it is running over here" leads somewhere, and the way out is
 * stopping the machine named. `stoppable` on it is what decides whether a stop
 * is offered at all -- a server says no while an agent is mid-turn, and a
 * button that cannot work is worse than no button.
 */
export type TreeFollowUp =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly words: string; readonly holder: SessionHolder | null };

export function treeFollowUp(
  pending: FrameId,
  lastChange: TreeChangeView | null,
  lastRefusal: RefusalView | null,
): TreeFollowUp {
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message, holder: lastRefusal.holder };
  }
  if (lastChange !== null && lastChange.replyTo === pending) return { kind: 'done' };
  return { kind: 'waiting' };
}

/** Whether a stop may be offered for that refusal, and for which machine. */
export function stopOffer(followUp: TreeFollowUp): SessionHolder | null {
  if (followUp.kind !== 'refused') return null;
  return followUp.holder !== null && followUp.holder.stoppable ? followUp.holder : null;
}

/** The name as the hub will read it: a name of spaces is the absence of one. */
export function parseNodeName(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}
