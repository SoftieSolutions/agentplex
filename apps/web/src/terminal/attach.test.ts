import { describe, expect, it } from 'vitest';
import { attachEmulator } from './attach.js';
import { createTerminalFeed } from './chunk-feed.js';
import { createFakeEmulatorFactory } from './fake-emulator.js';
import type { TerminalEmulator } from './emulator.js';
import { ptyChunks } from './pty-chunks.fixture.js';

/**
 * The lifecycle through the seam, with a fake emulator: no xterm, no DOM.
 * The container argument is ignored by the fake, so a placeholder stands in
 * for the element the real factory would render into.
 */
const NO_CONTAINER = null as unknown as HTMLElement;

function harness() {
  const emulators = createFakeEmulatorFactory();
  const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
  const typed: string[] = [];
  const announced: (TerminalEmulator | null)[] = [];
  const cleanup = attachEmulator({
    emulators,
    container: NO_CONTAINER,
    feed,
    onData: (data) => typed.push(data),
    emulatorReady: (emulator) => announced.push(emulator),
  });
  const emulator = emulators.created[0];
  if (emulator === undefined) throw new Error('the factory built nothing');
  return { feed, typed, announced, cleanup, emulator };
}

describe('attachEmulator', () => {
  it('replays what the feed already held, then streams what arrives', () => {
    const [replayed, live] = ptyChunks;
    if (replayed === undefined || live === undefined) throw new Error('fixture too small');
    const emulators = createFakeEmulatorFactory();
    const feed = createTerminalFeed({ maxBytes: 1024 * 1024 });
    feed.push(replayed);

    attachEmulator({ emulators, container: NO_CONTAINER, feed, onData: () => {} });
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

  it('tears down in the safe order: announce null, stop bytes, dispose', () => {
    const { feed, announced, cleanup, emulator } = harness();
    const chunk = ptyChunks[0];
    if (chunk === undefined) throw new Error('fixture too small');

    cleanup();
    feed.push(chunk);

    expect(announced).toEqual([emulator, null]);
    expect(emulator.written).toEqual([]);
    expect(emulator.disposed).toBe(true);
  });
});
