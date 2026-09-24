import { describe, expect, it } from 'vitest';
import { forbiddenKeysIn, keysOf } from './frame-keys.js';

/**
 * The guard's own test, because a guard that cannot fail guards nothing.
 *
 * The suites that use this walk frames a whole hub and server produced and
 * assert that nothing forbidden is in them, which passes just as happily when
 * the walk is broken as when the frames are clean. These are the cases that
 * tell those two apart.
 */
describe('forbiddenKeysIn', () => {
  it('finds a forbidden name however deep a frame buries it', () => {
    expect(
      forbiddenKeysIn({
        type: 'session-transcript-read',
        activities: [{ kind: 'command', command: 'pnpm test' }],
      }),
    ).toEqual(['command']);
    expect(forbiddenKeysIn({ type: 'x', state: { servers: [{ runs: [{ pid: 4 }] }] } })).toEqual([
      'pid',
    ]);
  });

  it('names every one it found, so a failure says which', () => {
    expect(forbiddenKeysIn({ argv: [], nested: { env: {} } })).toEqual(['argv', 'env']);
  });

  it('is about key names and never about values', () => {
    // A transcript activity's display text says what an agent ran, and saying
    // so is the whole point of the screen. What it may not do is arrive under
    // a name that reads as an instruction.
    expect(forbiddenKeysIn({ kind: 'command', text: 'pnpm test --env=ci' })).toEqual([]);
  });

  it('finds nothing in a graph document, whose conditions and prompts are values', () => {
    // A ROUTER's condition and an AGENT's prompt are text a person typed and
    // both may mention a command; both cross under names that read as text
    // about work, never as an instruction to run any.
    expect(
      forbiddenKeysIn({
        type: 'graph-document',
        replyTo: 5,
        nodeId: 'node-1',
        name: 'release',
        draftVersion: 2,
        document: {
          nodes: [
            {
              id: 'classify',
              kind: 'router',
              label: 'Classify',
              position: { x: 0, y: 0 },
              placement: { kind: 'pin', server: 'registration-1' },
              retry: { max: 1, backoff: 5 },
              model: 'haiku',
              routes: [{ condition: 'only src/**', to: 'review' }],
              otherwise: null,
            },
            {
              id: 'review',
              kind: 'agent',
              label: 'Review',
              position: { x: 1, y: 1 },
              placement: { kind: 'cheapest' },
              retry: { max: 0, backoff: 1 },
              prompt: 'run pnpm test and report',
              provider: 'claude',
              storeId: 'store-1',
            },
          ],
          edges: [{ from: 'classify', to: 'review' }],
        },
        published: [{ version: 1, publishedAt: 1 }],
      }),
    ).toEqual([]);
    // And a document that smuggled one in under a node is still caught.
    expect(
      forbiddenKeysIn({
        type: 'graph-save',
        id: 3,
        nodeId: 'node-1',
        document: { nodes: [{ id: 'x', kind: 'action', argv: ['rm'] }], edges: [] },
      }),
    ).toEqual(['argv']);
  });

  it('walks arrays and objects and stops at everything else', () => {
    expect(keysOf([{ a: 1 }, { b: { c: 2 } }])).toEqual(['a', 'b', 'c']);
    expect(keysOf(null)).toEqual([]);
    expect(keysOf('args')).toEqual([]);
  });
});
