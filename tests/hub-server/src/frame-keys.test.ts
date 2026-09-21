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

  it('walks arrays and objects and stops at everything else', () => {
    expect(keysOf([{ a: 1 }, { b: { c: 2 } }])).toEqual(['a', 'b', 'c']);
    expect(keysOf(null)).toEqual([]);
    expect(keysOf('args')).toEqual([]);
  });
});
