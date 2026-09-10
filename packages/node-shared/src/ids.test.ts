import { describe, expect, it } from 'vitest';
import { createFrameIdCounter, randomIdGenerator } from './ids.js';

describe('createFrameIdCounter', () => {
  it('starts at one, so that zero never reads as a frame id', () => {
    expect(createFrameIdCounter()()).toBe(1);
  });

  it('never repeats within a connection', () => {
    const next = createFrameIdCounter();
    const ids = [next(), next(), next()];
    expect(new Set(ids).size).toBe(3);
  });

  it('gives each connection its own sequence', () => {
    expect(createFrameIdCounter()()).toBe(createFrameIdCounter()());
  });
});

describe('randomIdGenerator', () => {
  it('mints distinct durable ids', () => {
    expect(randomIdGenerator.newId()).not.toBe(randomIdGenerator.newId());
  });
});
