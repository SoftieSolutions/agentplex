import type { Pty, PtyExit, PtyFactory, PtyRequest, PtySignal } from './pty.js';

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
  /** Every signal it was sent, in order, whether or not it died of one. */
  readonly signals: readonly PtySignal[];
  /** How many signals it was sent: `signals.length`, for a test that asks only that. */
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
  /**
   * A child that runs itself, instead of one a test drives by hand.
   *
   * Most tests here are about what the supervisor does with output that
   * arrives, so they emit and close where the assertion is. A caller that waits
   * for the child — setup's login step hands the operator's terminal over and
   * takes it back when the login ends — cannot do that: there is nowhere for
   * the test to stand between the launch and the wait. So the child prints and
   * ends on its own, which is what a login the operator completed looks like
   * from the outside.
   *
   * It happens in a microtask rather than inside `open`, because the supervisor
   * subscribes after `open` returns and a child that spoke first would be
   * talking to nobody.
   */
  readonly child?: FakeChild;
}

export interface FakeChild {
  /** What it prints, once. */
  readonly prints?: string;
  /** How it ends afterwards. Absent means it keeps running. */
  readonly exit?: PtyExit;
  /**
   * The signals it dies of. Any other is recorded and ignored.
   *
   * Absent, a signal ends nothing, which is the fake a test drives by hand and
   * closes itself. `['SIGHUP', 'SIGKILL']` is a well-behaved agent that exits
   * when its terminal hangs up; `['SIGKILL']` is one that catches the hangup
   * and carries on, which is the child a stop has to escalate past.
   *
   * The exit arrives in a microtask, as `child` does: a real process dies after
   * the signal is sent, never inside the call that sent it.
   */
  readonly diesOn?: readonly PtySignal[];
}

/**
 * The numbers the kernel reports for the signals a child can die of here.
 *
 * What node-pty hands `onExit` for a child a signal ended, so the fake's exit
 * reads the way the integration test proves a real one does.
 */
const SIGNAL_NUMBERS: Readonly<Record<PtySignal, number>> = {
  SIGHUP: 1,
  SIGKILL: 9,
  SIGTERM: 15,
};

export function createFakePtyFactory(options: FakePtyFactoryOptions = {}): FakePtyFactory {
  const opened: PtyRequest[] = [];
  const ptys: FakePty[] = [];

  return {
    open(request: PtyRequest): Pty {
      if (options.failsToOpen !== undefined) throw new Error(options.failsToOpen);

      opened.push(request);
      const pty = createFakePty(
        options.pids?.[ptys.length] ?? 1000 + ptys.length,
        options.child?.diesOn ?? [],
      );
      ptys.push(pty);

      const child = options.child;
      if (child !== undefined) {
        queueMicrotask(() => {
          if (child.prints !== undefined) pty.emit(child.prints);
          if (child.exit !== undefined) pty.close(child.exit);
        });
      }

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

function createFakePty(pid: number, diesOn: readonly PtySignal[]): FakePty {
  const dataListeners: ((chunk: Uint8Array) => void)[] = [];
  const exitListeners: ((exit: PtyExit) => void)[] = [];
  const written: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  const signals: PtySignal[] = [];
  /** Set by the first exit, so a child that is signalled twice dies once. */
  let exited = false;

  const pty: FakePty = {
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

    kill(signal: PtySignal): void {
      signals.push(signal);
      if (!diesOn.includes(signal)) return;
      queueMicrotask(() => {
        if (exited) return;
        pty.close({ exitCode: 0, signal: SIGNAL_NUMBERS[signal] });
      });
    },

    emit(chunk: Uint8Array | string): void {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      for (const listener of dataListeners) listener(bytes);
    },

    close(exit: PtyExit): void {
      exited = true;
      for (const listener of exitListeners) listener(exit);
    },

    get written() {
      return written;
    },

    get resizes() {
      return resizes;
    },

    get signals() {
      return signals;
    },

    get kills() {
      return signals.length;
    },
  };
  return pty;
}
