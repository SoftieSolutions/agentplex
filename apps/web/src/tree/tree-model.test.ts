import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type Layout,
  type MachineState,
  type NodeId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  buildForgetRemoval,
  buildMove,
  buildRemove,
  buildRename,
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

function refusalFrom(text: string) {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'refusal') throw new Error('not a refusal frame');
  const frame = parsed.value;
  return { replyTo: frame.replyTo, code: frame.code, message: frame.message, holder: frame.holder };
}

const ARRANGED = layoutFrom(hubFrames.layoutArranged);
const node = (id: string): NodeId => id as NodeId;

describe('where a node may be put', () => {
  it('offers the root and every container the hub sent', () => {
    expect(moveTargets(ARRANGED, node('hub-2'))).toEqual([
      { parentId: null, label: 'Top level' },
      { parentId: 'hub-7', label: 'this week' },
      { parentId: 'hub-5', label: 'agentplex (main checkout)' },
    ]);
  });

  it('leaves out the node itself and everything under it', () => {
    // `hub-7` is the folder and `hub-5` the project inside it. Neither is
    // somewhere the folder can go, and the hub would refuse both -- but a
    // menu offering a click that can only be refused is a menu wasting one.
    expect(moveTargets(ARRANGED, node('hub-7'))).toEqual([{ parentId: null, label: 'Top level' }]);
  });

  it('offers the root alone before any tree has been answered', () => {
    expect(moveTargets(null, node('hub-2'))).toEqual([{ parentId: null, label: 'Top level' }]);
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
  it('waits until something answers the id this menu sent', () => {
    expect(treeFollowUp(11, null, null)).toEqual({ kind: 'waiting' });
    // Somebody else's reply, on the same socket. A menu that read it would be
    // closing itself on an answer to a question it did not ask.
    expect(treeFollowUp(11, { replyTo: 9, nodeId: null }, null)).toEqual({ kind: 'waiting' });
    expect(treeFollowUp(11, { replyTo: 11, nodeId: null }, null)).toEqual({ kind: 'done' });
  });

  it('keeps the hub words and the machine on a refusal that names one', () => {
    const refusal = refusalFrom(hubFrames.refusalHolder);

    const followUp = treeFollowUp(refusal.replyTo, null, refusal);

    expect(followUp).toEqual({
      kind: 'refused',
      words: 'this session is still running; stop it first, and then remove it',
      holder: { server: 'registration-mbp-robert', stoppable: false },
    });
    // The captured hold says this one is mid-turn, so no stop is offered: a
    // server refuses to interrupt a turn, and a button that cannot work is
    // worse than no button.
    expect(stopOffer(followUp)).toBeNull();
    expect(
      stopOffer({
        kind: 'refused',
        words: followUp.kind === 'refused' ? followUp.words : '',
        holder: { server: 'registration-mbp-robert' as never, stoppable: true },
      }),
    ).toEqual({ server: 'registration-mbp-robert', stoppable: true });
  });

  it('offers no stop for a refusal that names no machine', () => {
    const refusal = refusalFrom(hubFrames.refusal);

    expect(stopOffer(treeFollowUp(refusal.replyTo, null, refusal))).toBeNull();
  });
});
