import { describe, expect, it } from 'vitest';
import { createShortcutRegistry, isChord, type ChordKeyEvent } from './shortcuts.js';

function event(overrides: Partial<ChordKeyEvent> & { key: string }): ChordKeyEvent & {
  readonly prevented: boolean;
  readonly stopped: boolean;
} {
  let prevented = false;
  let stopped = false;
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
    preventDefault(): void {
      prevented = true;
    },
    stopPropagation(): void {
      stopped = true;
    },
    get prevented(): boolean {
      return prevented;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}

function registryWith(key: string): {
  registry: ReturnType<typeof createShortcutRegistry>;
  runs: () => number;
} {
  const registry = createShortcutRegistry();
  let count = 0;
  registry.register({
    key,
    description: 'a test binding',
    run: () => {
      count += 1;
    },
  });
  return { registry, runs: () => count };
}

describe('isChord', () => {
  it('accepts Ctrl+Shift and Cmd+Shift, without Alt', () => {
    expect(isChord(event({ key: 't', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isChord(event({ key: 't', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isChord(event({ key: 't', ctrlKey: true }))).toBe(false);
    expect(isChord(event({ key: 't', shiftKey: true }))).toBe(false);
    expect(isChord(event({ key: 't' }))).toBe(false);
    expect(isChord(event({ key: 't', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });
});

describe('createShortcutRegistry', () => {
  it('consumes a matching chord: prevented, stopped, run', () => {
    const { registry, runs } = registryWith('t');
    const chord = event({ key: 't', ctrlKey: true, shiftKey: true });

    expect(registry.handleKeyDown(chord)).toBe(true);
    expect(runs()).toBe(1);
    expect(chord.prevented).toBe(true);
    expect(chord.stopped).toBe(true);
  });

  it('matches the shifted key case-insensitively, since Shift is part of the chord', () => {
    const { registry, runs } = registryWith('t');

    expect(registry.handleKeyDown(event({ key: 'T', metaKey: true, shiftKey: true }))).toBe(true);
    expect(runs()).toBe(1);
  });

  it('lets a plain keystroke through untouched, which is what keeps typing typing', () => {
    const { registry, runs } = registryWith('t');
    const plain = event({ key: 't' });

    expect(registry.handleKeyDown(plain)).toBe(false);
    expect(runs()).toBe(0);
    expect(plain.prevented).toBe(false);
    expect(plain.stopped).toBe(false);
  });

  it('lets an unbound chord through, so the browser keeps its own', () => {
    const { registry } = registryWith('t');
    const unbound = event({ key: 'r', ctrlKey: true, shiftKey: true });

    expect(registry.handleKeyDown(unbound)).toBe(false);
    expect(unbound.prevented).toBe(false);
  });

  it('unregisters, and a stale unregister does not remove a newer binding', () => {
    const registry = createShortcutRegistry();
    let ran = '';
    const first = registry.register({ key: 't', description: 'first', run: () => (ran = 'first') });
    registry.register({ key: 't', description: 'second', run: () => (ran = 'second') });

    first();
    registry.handleKeyDown(event({ key: 't', ctrlKey: true, shiftKey: true }));

    expect(ran).toBe('second');
    expect(registry.bindings().map((binding) => binding.description)).toEqual(['second']);
  });

  it('lists bindings for the shortcut help the layout ticket will draw', () => {
    const { registry } = registryWith('t');

    expect(registry.bindings()).toHaveLength(1);
    expect(registry.bindings()[0]?.description).toBe('a test binding');
  });
});
