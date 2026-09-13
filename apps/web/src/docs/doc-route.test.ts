import { describe, expect, it } from 'vitest';
import { nodeIdSchema } from '@agentplex/protocol';
import { docHash, parseDocHash } from './doc-route.js';

describe('the document address', () => {
  it('round-trips a node id, escaping what a hash cannot carry', () => {
    const nodeId = nodeIdSchema.parse('hub/5 6');
    expect(docHash(nodeId)).toBe('#/doc/hub%2F5%206');
    expect(parseDocHash(docHash(nodeId))).toBe('hub/5 6');
  });

  it('is no route for another address, an empty node or a broken escape', () => {
    expect(parseDocHash('#/session/store-1/session-1')).toBeNull();
    expect(parseDocHash('')).toBeNull();
    expect(parseDocHash('#/doc/')).toBeNull();
    expect(parseDocHash('#/doc/one/two')).toBeNull();
    expect(parseDocHash('#/doc/%E0%A4%A')).toBeNull();
  });
});
