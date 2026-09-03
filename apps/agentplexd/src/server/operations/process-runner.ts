/**
 * The one-shot process seam: the only way anything outside the PTY path starts
 * a child.
 *
 * Read the request type as the design. There is no `command` string, no `cwd`,
 * no `env`, and no `shell` — not "there is one and it defaults to false", but
 * no place to put one. A generic `{ command }` field is the failure mode the
 * operation registry exists to prevent, and a seam that accepts a string is
 * where that field would eventually be added by someone in a hurry. The type
 * has to refuse it before a reviewer has to.
 *
 * The three omissions each close a specific hole:
 *
 * - **No shell.** `shell: false` is baked into the implementation rather than
 *   passed, so no caller can turn it on and no argv element can become syntax.
 * - **No cwd.** A directory an operation cares about reaches the child as an
 *   argv element the child itself understands — `git -C <dir>` — so the
 *   directory is data the program parses rather than state the kernel applies.
 *   That keeps every path visible in the argv a test asserts on, and means a
 *   builder cannot silently relocate a child by forgetting a field.
 * - **No env.** The environment a child inherits is decided once, where the
 *   runner is constructed, from the process's own environment. Nothing an
 *   operation is asked to do can add to it, so no value arriving from outside
 *   can ever become a variable in a child.
 *
 * Output is decoded to text here, unlike the pty seam, which insists on bytes.
 * The difference is real: a pty carries a TUI's escape sequences to an emulator
 * and decoding it would corrupt it, whereas these children are `git` and `ps`,
 * writing lines that exist to be parsed and thrown away.
 */
export interface ProcessRunner {
  /**
   * Runs the program to completion and reports what it did.
   *
   * Never rejects. A program that is not installed, a program that hangs, a
   * program that writes more than the cap — all of them are outcomes a caller
   * has to answer for, and an exception would unwind past the operation that
   * knows what the failure means to the user.
   */
  run(request: ProcessRequest): Promise<ProcessOutcome>;
}

export interface ProcessRequest {
  /** The executable, looked up on PATH. Never a shell string; there is no shell. */
  readonly file: string;
  /**
   * The complete argument vector, already built by an operation from a parsed
   * request. Each element reaches the child as one argument whatever it
   * contains: no quoting, no splitting, no globbing.
   */
  readonly args: readonly string[];
  /**
   * How long to wait before killing it, in ms.
   *
   * Required rather than defaulted, because "how long may this block the
   * server" is a question each operation has to have answered. A one-shot probe
   * that never returns is indistinguishable from a slow one, and the caller is
   * a request the user is waiting on.
   */
  readonly timeoutMs: number;
}

/**
 * What running it produced.
 *
 * `exited` covers every program that ran and finished, whatever its exit code:
 * a nonzero code is the program's answer, and only the operation knows whether
 * it means "no" or "broken" — `git status` exits 128 in a directory that is
 * simply not a repository, which is a fact about the directory and not a fault.
 * `failed` is the machine refusing: nothing ran, or what ran was killed.
 */
export type ProcessOutcome =
  | ({ readonly kind: 'exited' } & CompletedProcess)
  | { readonly kind: 'failed'; readonly problem: string };

export interface CompletedProcess {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A request as one line, for a log message or a test's lookup table.
 *
 * It is a description and never an instruction: nothing in agentplexd parses
 * this back into a request or hands it to anything that could run it. The
 * elements are joined by spaces and not quoted, which is precisely why it must
 * not be re-executed — the string is lossy about the argv it came from, and the
 * argv is the truth.
 */
export function describeProcessRequest(request: ProcessRequest): string {
  return [request.file, ...request.args].join(' ');
}
