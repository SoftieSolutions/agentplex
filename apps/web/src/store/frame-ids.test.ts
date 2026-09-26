import { describe, expect, it } from 'vitest';
import { createFrameIds } from './frame-ids.js';

describe('createFrameIds', () => {
  it('yields 1, 2, 3', () => {
    const ids = createFrameIds();
    expect(ids.next()).toBe(1);
    expect(ids.next()).toBe(2);
    expect(ids.next()).toBe(3);
  });

  it('gives each counter its own sequence', () => {
    const first = createFrameIds();
    const second = createFrameIds();
    first.next();
    first.next();
    expect(second.next()).toBe(1);
    expect(first.next()).toBe(3);
  });
});
