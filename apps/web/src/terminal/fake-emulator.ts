import type { EmulatorFactory, TerminalEmulator } from './emulator.js';

/**
 * A `TerminalEmulator` a test can read: it records every chunk written and
 * lets the test play the user typing. No xterm, no DOM measurement — which is
 * the point of the seam.
 */
export interface FakeEmulator extends TerminalEmulator {
  readonly written: readonly Uint8Array[];
  /** The user typing: fires whatever onData listener the view wired up. */
  type(data: string): void;
  readonly focused: number;
  readonly disposed: boolean;
}

export interface FakeEmulatorFactory extends EmulatorFactory {
  readonly created: readonly FakeEmulator[];
}

export function createFakeEmulatorFactory(): FakeEmulatorFactory {
  const created: FakeEmulator[] = [];
  return {
    create(): FakeEmulator {
      const written: Uint8Array[] = [];
      const listeners: ((data: string) => void)[] = [];
      let focused = 0;
      let disposed = false;
      const emulator: FakeEmulator = {
        write(chunk: Uint8Array): void {
          written.push(chunk);
        },
        onData(listener: (data: string) => void): void {
          listeners.push(listener);
        },
        focus(): void {
          focused += 1;
        },
        dispose(): void {
          disposed = true;
        },
        type(data: string): void {
          for (const listener of [...listeners]) listener(data);
        },
        get written(): readonly Uint8Array[] {
          return [...written];
        },
        get focused(): number {
          return focused;
        },
        get disposed(): boolean {
          return disposed;
        },
      };
      created.push(emulator);
      return emulator;
    },
    get created(): readonly FakeEmulator[] {
      return [...created];
    },
  };
}
