import { describe, expect, it } from 'vitest';
import { nodeIdSchema } from '@agentplex/protocol';
import { graphHash, parseGraphHash } from './graph-route.js';

describe('the graph address', () => {
  it('round-trips a node id, escaping what a hash cannot carry', () => {
    const nodeId = nodeIdSchema.parse('hub/5 6');
    expect(graphHash(nodeId)).toBe('#/graph/hub%2F5%206');
    expect(parseGraphHash(graphHash(nodeId))).toBe('hub/5 6');
  });

  it('is no route for another address, an empty node or a broken escape', () => {
    expect(parseGraphHash('#/doc/hub-6')).toBeNull();
    expect(parseGraphHash('#/session/store-1/session-1')).toBeNull();
    expect(parseGraphHash('')).toBeNull();
    expect(parseGraphHash('#/graph/')).toBeNull();
    expect(parseGraphHash('#/graph/one/two')).toBeNull();
    expect(parseGraphHash('#/graph/%E0%A4%A')).toBeNull();
  });
});
