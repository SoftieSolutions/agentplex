import { describe, expect, it } from 'vitest';
import type { TerminalSize } from '@agentplex/protocol';
import { attachEmulator } from './attach.js';
import { createTerminalFeed } from './chunk-feed.js';
import { createFakeEmulatorFactory } from './fake-emulator.js';
import type { TerminalEmulator } from './emulator.js';
import { ptyChunks } from './pty-chunks.fixture.js';
import type { BoxObservers, FrameScheduler } from './resize.js';

/**
 * The lifecycle through the seam, with a fake emulator: no xterm, no DOM.
 * The container argument is ignored by the fake, so a placeholder stands in
 * for the element the real factory would render into.
 */
const NO_CONTAINER = null as unknown as HTMLElement;

/**
 * A box nothing is watching, and frames that run the moment they are asked
 * for. `resize.test.ts` is where the coalescing is held to its rule; here the
 * question is only whether the watch is wired up and torn down with the
 * element, so the schedule is made to disappear.
 */
function pretendBoxes(): { boxes: BoxObservers; move(): void; readonly watching: boolean } {
  let changed: (() => void) | null = null;
  return {
    boxes: {
      observe(_element, fire) {
        changed = fire;
        return () => {
          changed = null;
        };
      },
    },
    move: () => changed?.(),
    get watching(): boolean {
      return changed !== null;
    },
  };
}

const NOW: FrameScheduler = {
  schedule(run: () => void): () => void {
    run();
    return () => {};
  },
};

function harness() {
  const emulators = createFakeEmulatorFactory();
  const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
  const typed: string[] = [];
  const sizes: TerminalSize[] = [];
  const announced: (TerminalEmulator | null)[] = [];
  const observed = pretendBoxes();
  const cleanup = attachEmulator({
    emulators,
    container: NO_CONTAINER,
    feed,
    onData: (data) => typed.push(data),
    onResize: (size) => sizes.push(size),
    boxes: observed.boxes,
    frames: NOW,
    emulatorReady: (emulator) => announced.push(emulator),
  });
  const emulator = emulators.created[0];
  if (emulator === undefined) throw new Error('the factory built nothing');
  return { feed, typed, sizes, announced, cleanup, emulator, observed };
}

describe('attachEmulator', () => {
  it('replays what the feed already held, then streams what arrives', () => {
    const [replayed, live] = ptyChunks;
    if (replayed === undefined || live === undefined) throw new Error('fixture too small');
    const emulators = createFakeEmulatorFactory();
    const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
    feed.push(replayed);

    attachEmulator({
      emulators,
      container: NO_CONTAINER,
      feed,
      onData: () => {},
      onResize: () => {},
      boxes: pretendBoxes().boxes,
      frames: NOW,
    });
    feed.push(live);

    expect(emulators.created[0]?.written).toEqual([replayed, live]);
  });

  it('routes keystrokes from the emulator to onData', () => {
    const { typed, emulator } = harness();

    emulator.type('ls\r');

    expect(typed).toEqual(['ls\r']);
  });

  it('announces the emulator on attach, so the focus shortcut has something to aim at', () => {
    const { announced, emulator } = harness();

    expect(announced).toEqual([emulator]);
  });

  it('fits the emulator when the box it is drawn in moves', () => {
    const { emulator, observed } = harness();
    const before = emulator.fitted;

    observed.move();

    expect(emulator.fitted).toBe(before + 1);
  });

  it('reports the size the emulator settled on, inside what a frame may carry', () => {
    const { sizes, emulator } = harness();

    emulator.resizeTo({ cols: 120, rows: 40 });
    // Larger than the protocol allows, which the pane must not be the peer to
    // send: a parser on the far end would say no and cost the pane its
    // subscription over a number it measured off a box.
    emulator.resizeTo({ cols: 4_000, rows: 4_000 });

    expect(sizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 1_000, rows: 1_000 },
    ]);
  });

  it('tears down in the safe order: announce null, stop bytes, stop fitting, dispose', () => {
    const { feed, announced, cleanup, emulator, observed } = harness();
    const chunk = ptyChunks[0];
    if (chunk === undefined) throw new Error('fixture too small');

    cleanup();
    feed.push(chunk);
    observed.move();

    expect(announced).toEqual([emulator, null]);
    expect(emulator.written).toEqual([]);
    expect(emulator.disposed).toBe(true);
    // Nothing is left watching a box for an emulator that has been disposed.
    expect(observed.watching).toBe(false);
  });
});
