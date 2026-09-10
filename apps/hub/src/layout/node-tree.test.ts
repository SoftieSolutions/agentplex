import { describe, expect, it } from 'vitest';
import { nodeIdSchema, nodeKindSchema, type NodeId } from '@agentplex/protocol';
import { orderDepthFirst, type TreeNode } from './node-tree.js';

/**
 * The tree order, without a database.
 *
 * Ordering is done here rather than in SQL precisely so it can be read and
 * tested like this: a depth-first order in SQLite is a recursive CTE over a
 * `printf`-padded path, and the padding width is a silent limit on how many
 * siblings a folder may hold before the order goes quietly wrong.
 */

function node(id: string, parentId: string | null, position: number): TreeNode {
  return {
    id: nodeIdSchema.parse(id),
    parentId: parentId === null ? null : nodeIdSchema.parse(parentId),
    kind: nodeKindSchema.parse('folder'),
    position,
    name: id,
    named: false,
    anchor: null,
    createdAt: 0,
  };
}

function idsOf(nodes: readonly TreeNode[]): readonly NodeId[] {
  return nodes.map((one) => one.id);
}

describe('ordering a node tree', () => {
  it('has nothing to say about an empty tree', () => {
    expect(orderDepthFirst([])).toEqual([]);
  });

  it('puts siblings in position order regardless of the order they arrived in', () => {
    const ordered = orderDepthFirst([node('c', null, 2), node('a', null, 0), node('b', null, 1)]);

    expect(idsOf(ordered)).toEqual(['a', 'b', 'c']);
  });

  it('puts a parent before its children', () => {
    const ordered = orderDepthFirst([
      node('child', 'parent', 0),
      node('parent', null, 0),
      node('after', null, 1),
    ]);

    expect(idsOf(ordered)).toEqual(['parent', 'child', 'after']);
  });

  it('walks a whole subtree before moving to the next sibling', () => {
    const ordered = orderDepthFirst([
      node('one', null, 0),
      node('one-a', 'one', 0),
      node('one-a-i', 'one-a', 0),
      node('one-b', 'one', 1),
      node('two', null, 1),
    ]);

    expect(idsOf(ordered)).toEqual(['one', 'one-a', 'one-a-i', 'one-b', 'two']);
  });

  /**
   * Two siblings at the same position is not a state this codebase writes --
   * positions are rewritten densely on every move -- but the order still has to
   * be total, or two clients sorting the same rows could disagree about one
   * tree.
   */
  it('breaks a tie on the id, so the order is total', () => {
    const ordered = orderDepthFirst([node('b', null, 0), node('a', null, 0)]);

    expect(idsOf(ordered)).toEqual(['a', 'b']);
  });

  /**
   * Neither of the two states below can be written through this module: the
   * foreign key refuses a missing parent and `moveNode` refuses a cycle. If one
   * appears anyway, the listing must not silently lose the rows -- an
   * unreadable item costs itself, not the listing.
   */
  it('appends a node whose parent is missing rather than dropping it', () => {
    const ordered = orderDepthFirst([node('root', null, 0), node('orphan', 'nowhere', 0)]);

    expect(idsOf(ordered)).toEqual(['root', 'orphan']);
  });

  it('terminates on a ring, and reports the nodes in it rather than looping', () => {
    const ordered = orderDepthFirst([node('root', null, 0), node('a', 'b', 0), node('b', 'a', 0)]);

    expect(idsOf(ordered)).toEqual(['root', 'a', 'b']);
  });
});
