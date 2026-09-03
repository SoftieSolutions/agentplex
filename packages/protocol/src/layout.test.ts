import { describe, expect, it } from 'vitest';
import { layoutNodeSchema, layoutSchema } from './layout.js';
import { nodeIdSchema, nodeKindSchema, sessionIdSchema, storeIdSchema } from './identity.js';

/**
 * The layout as a client reads it.
 *
 * The assertions worth having here are the two design decisions the shape
 * encodes: a kind is an open string, because a new kind is a row in the hub's
 * database rather than a protocol change; and a node's anchor is a session
 * reference or nothing, never half of one.
 */

const folder = {
  id: nodeIdSchema.parse('node-1'),
  parentId: null,
  kind: nodeKindSchema.parse('folder'),
  position: 0,
  name: 'this week',
  named: true,
  anchor: null,
};

describe('a layout node', () => {
  it('accepts a folder at the root', () => {
    expect(layoutNodeSchema.parse(folder)).toEqual(folder);
  });

  it('accepts a session node anchored to its store and session', () => {
    const node = {
      ...folder,
      id: nodeIdSchema.parse('node-2'),
      parentId: nodeIdSchema.parse('node-1'),
      kind: nodeKindSchema.parse('session'),
      name: null,
      named: false,
      anchor: {
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
    };

    expect(layoutNodeSchema.parse(node)).toEqual(node);
  });

  /**
   * The wire half of kind-as-foreign-key. A `z.enum` here would make every new
   * node kind a protocol change and a client release, which is exactly the
   * schema rewrite the lookup table was spent to avoid.
   */
  it('accepts a kind this build has never heard of', () => {
    const node = { ...folder, kind: nodeKindSchema.parse('saved-search') };

    expect(layoutNodeSchema.parse(node).kind).toBe('saved-search');
  });

  it('refuses half an anchor, since a session id without its store names nothing', () => {
    const node = { ...folder, anchor: { sessionId: sessionIdSchema.parse('session-1') } };

    expect(layoutNodeSchema.safeParse(node).success).toBe(false);
  });

  it('refuses an empty name, which is a different thing from having none', () => {
    expect(layoutNodeSchema.safeParse({ ...folder, name: '' }).success).toBe(false);
    expect(layoutNodeSchema.safeParse({ ...folder, name: null }).success).toBe(true);
  });

  it('refuses a negative position', () => {
    expect(layoutNodeSchema.safeParse({ ...folder, position: -1 }).success).toBe(false);
  });

  it('refuses a node with no kind at all', () => {
    const { kind: _kind, ...withoutKind } = folder;
    expect(layoutNodeSchema.safeParse(withoutKind).success).toBe(false);
  });
});

describe('a layout', () => {
  it('is a flat list, so the parent relation has one encoding and cannot disagree', () => {
    const nodes = [folder, { ...folder, id: nodeIdSchema.parse('node-2'), position: 1 }];

    expect(layoutSchema.parse(nodes)).toHaveLength(2);
  });

  it('accepts an empty tree, which is what a hub starts with', () => {
    expect(layoutSchema.parse([])).toEqual([]);
  });
});
