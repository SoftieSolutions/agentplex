/**
 * The pseudoterminal seam.
 *
 * PTY attach is the only way to drive a coding agent: every one of them is a
 * TUI that asks `isTTY` and, on a pipe, turns off its prompt, its keybindings
 * and half its output. A pipe would look like it worked and would never
 * produce a session anyone could answer a permission prompt in.
 *
 * It is an interface because opening a real PTY is a native addon, a fork and
 * a controlling terminal — none of which a unit test can supply, and all of
 * which make the buffering and environment rules above it untestable if they
 * are reached through `require('node-pty')` directly. `node-pty-factory.ts` is
 * the implementation; `fake-pty.ts` is the one tests drive.
 *
 * Bytes are `Uint8Array` and never strings. Terminal output is not text: it is
 * a stream carrying escape sequences and, mid-stream, half a UTF-8 code point.
 * Decoding it here would corrupt exactly the sessions that use box drawing and
 * emoji, and nothing in agentplex has any reason to read it — it goes to an
 * emulator in the browser and nowhere else.
 */
export interface PtyFactory {
  /**
   * Opens a pty and starts the process on it.
   *
   * Throws when the process cannot be started. That is deliberate: unlike the
   * refusals the provider seam returns, this is not a decision anyone made, it
   * is the machine saying no, and there is no useful union of ways a fork can
   * fail. The supervisor catches it once and turns it into a value.
   */
  open(request: PtyRequest): Pty;
}

export interface PtyRequest {
  /** The executable, looked up on PATH. Never a shell string; there is no shell. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The child's complete environment. Complete, not a set of additions: the
   * supervisor has already decided what the child inherits, and a seam that
   * merged in `process.env` underneath would silently undo the scrub.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  /** What to set `TERM` to. The terminal a TUI thinks it is talking to. */
  readonly term: string;
}

export interface Pty {
  /** The child's pid, so a caller can hand it to a `ProcessProbe`. */
  readonly pid: number;
  /** Raw output. Subscribing twice delivers to both; nothing is replayed. */
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  /** Keystrokes, as the user typed them. */
  write(input: string): void;
  resize(cols: number, rows: number): void;
  /** Signals the child. A pty that has already exited ignores it. */
  kill(): void;
}

export interface PtyExit {
  readonly exitCode: number;
  /** The signal that ended it, or `null` when it exited on its own. */
  readonly signal: number | null;
}
