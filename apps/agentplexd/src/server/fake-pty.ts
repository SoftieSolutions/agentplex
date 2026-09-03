import type { Pty, PtyExit, PtyFactory, PtyRequest } from './pty.js';

/**
 * A pty a test can drive by hand.
 *
 * A real implementation of the seam rather than a mock, for the same reason
 * `fake-process-probe` is one: what the supervisor has to get right is what it
 * does with output that arrives, output that arrives after an exit, a child
 * that dies on a signal and a fork that fails — and every one of those is a
 * value this can produce. Asserting that `open` was called would test the
 * supervisor's shape instead of its behaviour.
 *
 * The one thing it is here to make testable at all is the environment. A real
 * pty would need a child that prints its own `environ` and a test that waits
 * for it; the fake keeps the request, so the scrub is a plain assertion on a
 * record. The integration test proves the same thing against a real process,
 * once, where a fake cannot: that a pty opens on this machine.
 */
export interface FakePty extends Pty {
  /** Output from the child. A string is encoded UTF-8; bytes go through as they are. */
  emit(chunk: Uint8Array | string): void;
  /** Ends the child. Emitting after this is allowed, and is what a real pty does. */
  close(exit: PtyExit): void;
  readonly written: readonly string[];
  readonly resizes: readonly { readonly cols: number; readonly rows: number }[];
  readonly kills: number;
}

export interface FakePtyFactory extends PtyFactory {
  /** Every request, in order, exactly as the supervisor built it. */
  readonly opened: readonly PtyRequest[];
  readonly ptys: readonly FakePty[];
  /** The most recently opened pty, for the common single-launch test. */
  readonly last: FakePty | undefined;
}

export interface FakePtyFactoryOptions {
  /**
   * Makes `open` throw with this message, which is how a machine refusing to
   * fork actually reaches the supervisor — `posix_spawnp failed.` out of a
   * native addon, with no path and no errno.
   */
  readonly failsToOpen?: string;
  /** The pid handed to each pty in turn, so a test can name one. */
  readonly pids?: readonly number[];
}

export function createFakePtyFactory(options: FakePtyFactoryOptions = {}): FakePtyFactory {
  const opened: PtyRequest[] = [];
  const ptys: FakePty[] = [];

  return {
    open(request: PtyRequest): Pty {
      if (options.failsToOpen !== undefined) throw new Error(options.failsToOpen);

      opened.push(request);
      const pty = createFakePty(options.pids?.[ptys.length] ?? 1000 + ptys.length);
      ptys.push(pty);
      return pty;
    },

    get opened() {
      return opened;
    },

    get ptys() {
      return ptys;
    },

    get last() {
      return ptys.at(-1);
    },
  };
}

function createFakePty(pid: number): FakePty {
  const dataListeners: ((chunk: Uint8Array) => void)[] = [];
  const exitListeners: ((exit: PtyExit) => void)[] = [];
  const written: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  let kills = 0;

  return {
    pid,

    onData(listener: (chunk: Uint8Array) => void): void {
      dataListeners.push(listener);
    },

    onExit(listener: (exit: PtyExit) => void): void {
      exitListeners.push(listener);
    },

    write(input: string): void {
      written.push(input);
    },

    resize(cols: number, rows: number): void {
      resizes.push({ cols, rows });
    },

    kill(): void {
      kills += 1;
    },

    emit(chunk: Uint8Array | string): void {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      for (const listener of dataListeners) listener(bytes);
    },

    close(exit: PtyExit): void {
      for (const listener of exitListeners) listener(exit);
    },

    get written() {
      return written;
    },

    get resizes() {
      return resizes;
    },

    get kills() {
      return kills;
    },
  };
}
