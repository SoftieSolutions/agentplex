/**
 * The emulator seam: what the terminal pane needs from xterm, and no more.
 *
 * An interface rather than the xterm Terminal class, for the same reason the
 * server's pty is an interface: constructing the real thing needs a DOM
 * element and a renderer, neither of which a unit test can supply, and every
 * rule worth testing here — replay order, whole-chunk trimming, the attach
 * lifecycle — is about what flows through the seam, not about how xterm
 * paints. `xterm-emulator.ts` is the implementation; `fake-emulator.ts` is
 * the one tests drive.
 *
 * Bytes are `Uint8Array` on the way in and never React state on the way
 * anywhere: output goes socket to feed to emulator through `write`, and the
 * only thing React ever holds is the ref-callback that wired them together.
 */

/** Anything terminal output can be written into. */
export interface EmulatorSink {
  write(chunk: Uint8Array): void;
}

/** The live emulator, as the pane drives it. */
export interface TerminalEmulator extends EmulatorSink {
  /** Keystrokes, as xterm encoded them. Arrow keys and Enter are sequences. */
  onData(listener: (data: string) => void): void;
  focus(): void;
  dispose(): void;
}

/**
 * Builds one emulator into one container. Injected into the terminal view so
 * a test can hand it a fake; the default is the xterm factory.
 */
export interface EmulatorFactory {
  create(container: HTMLElement): TerminalEmulator;
}
