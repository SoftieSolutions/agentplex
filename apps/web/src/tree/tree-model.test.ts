import { describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  HOME_PROJECT_NAME,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type Layout,
  type MachineState,
  type NodeId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { answersOf, replyFrom, withOutstanding } from '../store/replies.fixture.js';
import {
  buildForgetRemoval,
  buildMove,
  buildRemove,
  buildRename,
  menuOffers,
  moveTargets,
  nodeForSession,
  parseNodeName,
  sessionsNotInTree,
  stopOffer,
  treeFollowUp,
} from './tree-model.js';

/**
 * The tree menus' rules, against frames a real hub sent.
 *
 * Every layout and every refusal here is captured (`hub-frames.fixture.ts`):
 * the arranged tree is one a client built by sending the five edits over a
 * websocket, and the refusal with a machine on it is the hub declining to
 * remove a session a server said it was running. A hand-written layout would
 * test that these functions can read what their author imagined.
 */

function layoutFrom(text: string): Layout {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'layout') throw new Error('not a layout frame');
  return parsed.value.nodes;
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') throw new Error('not a state frame');
  return parsed.value.state;
}

const ARRANGED = layoutFrom(hubFrames.layoutArranged);
const node = (id: string): NodeId => id as NodeId;

interface MoveTargetShape {
  readonly parentId: string;
  readonly label: string;
}

/** Every folder and project the captured tree holds but `excluded`, in its order. */
function containersOutside(
  layout: Layout,
  excluded: readonly string[],
): readonly MoveTargetShape[] {
  return layout
    .filter((candidate) => candidate.kind === 'folder' || candidate.kind === 'project')
    .filter((candidate) => !excluded.includes(candidate.id))
    .map((candidate) => ({ parentId: candidate.id, label: candidate.name ?? candidate.id }));
}

function kindOf(layout: Layout, id: string): string | undefined {
  return layout.find((candidate) => candidate.id === id)?.kind;
}

describe('where a node may be put', () => {
  // The captured tree, read rather than assumed: HOME first at the root, a
  // folder inside it holding a session, a session straight under HOME, and a
  // second project. Every count below is taken from it.
  it('holds the captured shapes these cases are about', () => {
    expect(kindOf(ARRANGED, HOME_PROJECT_ID)).toBe('project');
    expect(kindOf(ARRANGED, 'hub-5')).toBe('project');
    expect(kindOf(ARRANGED, 'hub-7')).toBe('folder');
    expect(kindOf(ARRANGED, 'hub-2')).toBe('session');
    expect(ARRANGED.find((candidate) => candidate.id === 'hub-2')?.parentId).toBe('hub-7');
  });

  it('offers a session every project and folder, HOME by its name, and never the root', () => {
    const targets = moveTargets(ARRANGED, node('hub-2'));

    expect(targets).toEqual(containersOutside(ARRANGED, []));
    expect(targets).toContainEqual({ parentId: HOME_PROJECT_ID, label: HOME_PROJECT_NAME });
    expect(targets.some((target) => target.parentId === null)).toBe(false);
  });

  it('offers a folder every container outside its own subtree, and never the root', () => {
    const targets = moveTargets(ARRANGED, node('hub-7'));

    // The folder holds a session and no container, so only the folder itself
    // drops out of the list.
    expect(targets).toEqual(containersOutside(ARRANGED, ['hub-7']));
    expect(targets).toContainEqual({ parentId: HOME_PROJECT_ID, label: HOME_PROJECT_NAME });
    expect(targets.some((target) => target.parentId === null)).toBe(false);
  });

  it('offers a project nowhere, HOME included', () => {
    // A project sits at the top level and never inside another node, and the
    // top level is not offered either: the hub refuses every other place.
    expect(moveTargets(ARRANGED, node('hub-5'))).toEqual([]);
    expect(moveTargets(ARRANGED, HOME_PROJECT_ID)).toEqual([]);
  });

  it('offers nothing before any tree has been answered', () => {
    expect(moveTargets(null, node('hub-2'))).toEqual([]);
    expect(moveTargets(null, node('hub-5'))).toEqual([]);
    expect(moveTargets(null, HOME_PROJECT_ID)).toEqual([]);
  });
});

describe('what the menu offers', () => {
  it('offers HOME nothing, because the hub refuses every edit of it', () => {
    expect(menuOffers(ARRANGED, HOME_PROJECT_ID)).toEqual({
      rename: false,
      move: false,
      remove: false,
    });
    // By id, not by what the tree calls it: a layout not yet answered still
    // knows which node HOME is.
    expect(menuOffers(null, HOME_PROJECT_ID)).toEqual({
      rename: false,
      move: false,
      remove: false,
    });
  });

  it('offers another project a rename and a removal, and no move', () => {
    expect(menuOffers(ARRANGED, node('hub-5'))).toEqual({
      rename: true,
      move: false,
      remove: true,
    });
  });

  it('offers a session and a folder all three', () => {
    for (const id of ['hub-2', 'hub-7']) {
      expect(menuOffers(ARRANGED, node(id))).toEqual({ rename: true, move: true, remove: true });
    }
  });

  it('offers no move while there is nowhere known to move to', () => {
    expect(menuOffers(null, node('hub-2'))).toEqual({ rename: true, move: false, remove: true });
  });

  it('identifies HOME by its id, never by its name', () => {
    const renamedElsewhere = ARRANGED.map((candidate) =>
      candidate.id === 'hub-5' ? { ...candidate, name: HOME_PROJECT_NAME } : candidate,
    );
    expect(menuOffers(renamedElsewhere, node('hub-5')).rename).toBe(true);
  });
});

describe('reading the tree', () => {
  it('finds the node pointing at one session, by both halves of its identity', () => {
    const ref = sessionRefSchema.parse({
      storeId: 'store-agentplex',
      sessionId: 'session-fix-auth',
    });

    expect(nodeForSession(ARRANGED, ref)?.id).toBe('hub-2');
    // A session id is unique only inside its store, so a match on one half is
    // no match at all.
    expect(
      nodeForSession(
        ARRANGED,
        sessionRefSchema.parse({ storeId: 'store-universe', sessionId: 'session-fix-auth' }),
      ),
    ).toBeNull();
  });
});

describe('the sessions the tree does not hold', () => {
  it('is every session the fleet reports with no node pointing at it', () => {
    const state = stateFrom(hubFrames.machineStateSingle);

    // The captured state has two sessions and the captured tree points at
    // both, so nothing is absent.
    expect(sessionsNotInTree(state, ARRANGED)).toEqual([]);

    const withoutOne = ARRANGED.filter((candidate) => candidate.id !== 'hub-2');
    expect(sessionsNotInTree(state, withoutOne).map((absent) => absent.name)).toEqual([
      'fix-auth-refresh',
    ]);
  });

  /**
   * "No layout has been answered yet" is not "the tree is empty". Claiming
   * every session is missing while the first answer is in flight would put the
   * whole fleet under a heading that says it is not in the tree.
   */
  it('claims nothing before the first layout has arrived', () => {
    expect(sessionsNotInTree(stateFrom(hubFrames.machineStateSingle), null)).toEqual([]);
  });
});

describe('what the frames carry', () => {
  it('trims a name, so two clients cannot store two spellings of one intent', () => {
    expect(buildRename(node('hub-2'), '  the auth one  ')).toEqual({
      type: 'node-rename',
      nodeId: 'hub-2',
      name: 'the auth one',
    });
    expect(parseNodeName('   ')).toBeNull();
  });

  it('sends a move to the end of its new siblings, which the hub clamps', () => {
    expect(buildMove(node('hub-2'), node('hub-6'))).toMatchObject({
      type: 'node-move',
      nodeId: 'hub-2',
      parentId: 'hub-6',
    });
    expect(buildRemove(node('hub-2'))).toEqual({ type: 'node-remove', nodeId: 'hub-2' });
  });

  it('addresses a forgetting by the session, because the node is gone', () => {
    const ref = sessionRefSchema.parse({
      storeId: 'store-agentplex',
      sessionId: 'session-spike-wasm',
    });

    expect(buildForgetRemoval(ref)).toEqual({
      type: 'node-forget-removal',
      storeId: 'store-agentplex',
      sessionId: 'session-spike-wasm',
    });
  });
});

describe('what to do with the hub answer', () => {
  // A thin mapping over `followUp` across the five edits' answers.
  it('waits until something answers the id this menu sent', () => {
    const moved = replyFrom(hubFrames.nodeMoved, 'node-moved');
    expect(treeFollowUp(11, withOutstanding(answersOf(), 11))).toEqual({ kind: 'waiting' });
    // Somebody else's reply, on the same socket. A menu that read it would be
    // closing itself on an answer to a question it did not ask.
    expect(treeFollowUp(11, withOutstanding(answersOf(moved), 11))).toEqual({ kind: 'waiting' });
    expect(treeFollowUp(moved.replyTo, answersOf(moved))).toEqual({ kind: 'done' });
  });

  it('is idle once the id this menu sent is neither answered nor owed an answer', () => {
    // Its answer was pushed out by later ones, or the connection it went out
    // on dropped: nothing is coming, and a form that went on waiting would
    // stay disabled until it was closed.
    expect(treeFollowUp(11, answersOf())).toEqual({ kind: 'idle' });
  });

  it('is done on any of the five edits the hub answers', () => {
    for (const reply of [
      replyFrom(hubFrames.nodeCreated, 'node-created'),
      replyFrom(hubFrames.nodeRenamed, 'node-renamed'),
      replyFrom(hubFrames.nodeMoved, 'node-moved'),
      replyFrom(hubFrames.nodeRemoved, 'node-removed'),
      replyFrom(hubFrames.nodeRemovalForgotten, 'node-removal-forgotten'),
    ]) {
      expect(treeFollowUp(reply.replyTo, answersOf(reply))).toEqual({ kind: 'done' });
    }
  });

  it('keeps the hub words and the machine on a refusal that names one', () => {
    const refusal = replyFrom(hubFrames.refusalHolder, 'refusal');

    const followUp = treeFollowUp(refusal.replyTo, answersOf(refusal));

    expect(followUp).toEqual({
      kind: 'refused',
      words: 'this session is still running; stop it first, and then remove it',
      holder: { server: 'registration-mbp-robert', stoppable: false, pause: 'none' },
    });
    // The captured hold says this one is mid-turn, so no stop is offered: a
    // server refuses to interrupt a turn, and a button that cannot work is
    // worse than no button.
    expect(stopOffer(followUp)).toBeNull();
    expect(
      stopOffer({
        kind: 'refused',
        words: followUp.kind === 'refused' ? followUp.words : '',
        holder: { server: 'registration-mbp-robert' as never, stoppable: true, pause: 'none' },
      }),
    ).toEqual({ server: 'registration-mbp-robert', stoppable: true, pause: 'none' });
  });

  it('offers no stop for a refusal that names no machine', () => {
    const refusal = replyFrom(hubFrames.refusal, 'refusal');

    expect(stopOffer(treeFollowUp(refusal.replyTo, answersOf(refusal)))).toBeNull();
  });
});
