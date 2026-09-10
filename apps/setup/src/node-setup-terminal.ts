import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Attached, AttachedProgram, SetupTerminal, TerminalInput } from './setup-terminal.js';

/**
 * The real terminal, named in one place so nothing else has to reach for a
 * stream.
 *
 * The streams arrive as arguments rather than being read off `process`, for the
 * same reason the child environment does: the entrypoint is where this process's
 * own world is read, and a module that reaches for `process.stdin` is a module
 * that can only run inside a real one.
 *
 * The shape here is gotchas rather than preferences, each verified at the origin
 * on Node 24.20 and each silent in the direction that loses an answer.
 *
 * - `readline`'s own `question` — the obvious way to write this — **never
 *   settles when the input ends while it is pending**. `agentplex setup <
 *   /dev/null` would hang forever on the first question rather than reporting
 *   that there is nobody to ask, and so would a `^D` at any prompt.
 * - Racing `question` against the interface's `close` event does not fix that:
 *   when a line and the end of input arrive in the same tick, `close` resolves a
 *   microtask before the question does, and the race throws away an answer the
 *   operator actually typed. `line` and `close` are emitted in order by one
 *   emitter, so listening for both directly is the only arrangement in which
 *   "the operator typed this" reliably beats "the input has ended".
 * - A piped input is **read ahead of the questions**. `printf 'both\n8080\n' |
 *   agentplex setup` emits both lines as they arrive whether or not anything is
 *   asking, so a terminal that only listens while a question is outstanding
 *   drops every answer that arrived early — silently, and answering the
 *   questions it did hear with the wrong lines. Lines nobody has asked for yet
 *   are therefore kept, and a question takes the oldest one before it waits.
 * - **An interface cannot be lent out; it has to be given up.** `pause()` does
 *   not stop a readline reading — in terminal mode it is holding a `keypress`
 *   listener on the input and echoing what it sees — so an `attach` that merely
 *   paused it would have the wizard's line reader eating the operator's
 *   keystrokes, echoing them beside the login's own echo, and keeping whatever
 *   it parsed as an answer to the next question. `close()` releases the input,
 *   removes its listeners and puts raw mode back the way it found it; the next
 *   question builds a fresh one and picks up where the old one left off. The
 *   unclaimed lines outlive both, because they are this closure's and not
 *   readline's.
 * - The last is about the end rather than the middle, and it is the one a stream
 *   cannot show you. **An input that has been read holds the event loop open
 *   until it ends, and a terminal never ends.** A piped run exits because the
 *   pipe ran out, which is why every test above it passes; a person at a tty
 *   gets a finished wizard and a shell prompt that never comes back. Measured at
 *   the origin on the same Node: after the last question, `close()` on the
 *   interface releases readline's listeners and pauses the input and the process
 *   still does not exit, and `pause()` on the input does not help either — the
 *   handle stays referenced. `unref` is what releases it. So `close` does both,
 *   and it is on the returned type rather than on `SetupTerminal`: closing a
 *   terminal is a property of the one that owns an interface, not of the
 *   abstraction the wizard asks questions through, and whoever opened it is the
 *   one that closes it.
 *
 * The interface is created at the first question rather than at construction for
 * the same reason. `createInterface` attaches a `data` listener immediately, so a
 * terminal that is built and never asked anything — which is every
 * `agentplex setup --plan` run — would resume stdin and hang a replay that has
 * nobody at it at all. It is also what makes lending the terminal out cheap: an
 * `attach` gives the interface up and leaves nothing behind, and the next
 * question builds the next one.
 *
 * `setPrompt`/`prompt` is what puts the question on the output, so readline
 * knows the prompt's width and line editing on a real terminal redraws
 * correctly.
 */

/**
 * The parts of a terminal a raw attach needs, over and above a stream.
 *
 * Optional because the seam takes streams — a pipe is a legitimate input, and
 * what it cannot do is be handed to an interactive program. `process.stdin` and
 * `process.stdout` satisfy these; a `PassThrough` does not, and answering
 * "there is no terminal here" is the point rather than a limitation.
 */
export interface TerminalReadable extends Readable {
  readonly isTTY?: boolean;
  setRawMode?: (raw: boolean) => void;
}

export interface TerminalWritable extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface NodeSetupTerminalStreams {
  readonly input: TerminalReadable;
  readonly output: TerminalWritable;
}

export interface NodeSetupTerminal extends SetupTerminal {
  /**
   * Gives the input back.
   *
   * Safe to call when nothing was ever asked, and safe to call twice. Every
   * question after it is answered "ended", which is the truth: there is nothing
   * left listening.
   */
  close(): void;
}

/**
 * The size a pty is born at when the operator's terminal will not say.
 *
 * The same 80x24 the supervisor uses, and for the same reason: it is the size
 * every TUI is written to survive.
 */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

export function createNodeSetupTerminal({
  input,
  output,
}: NodeSetupTerminalStreams): NodeSetupTerminal {
  /** Lines that arrived before anything asked for them. Oldest first. */
  const unclaimed: string[] = [];
  let waiting: ((input: TerminalInput) => void) | null = null;
  let readline: Interface | null = null;
  let closed = false;
  /** True while an `attach` is giving the interface up on purpose. */
  let lending = false;

  const answer = (input: TerminalInput): boolean => {
    const resolve = waiting;
    if (resolve === null) return false;
    waiting = null;
    resolve(input);
    return true;
  };

  /** Built at the first question, because building one starts a read. */
  const reading = (): Interface => {
    if (readline !== null) return readline;

    const started = createInterface({ input, output });
    readline = started;

    started.on('line', (text: string) => {
      if (!answer({ kind: 'typed', text })) unclaimed.push(text);
    });

    started.once('close', () => {
      // A close this module asked for is the terminal being lent out or given
      // back, not the operator going away. Without this an `attach` would end
      // the wizard the moment it handed the terminal over.
      if (lending) return;
      closed = true;
      answer({ kind: 'ended' });
    });

    return started;
  };

  /** Releases the interface without deciding what that means. */
  const stopReading = (): void => {
    lending = true;
    readline?.close();
    readline = null;
    lending = false;
  };

  return {
    write(line: string): void {
      output.write(`${line}\n`);
    },

    async ask(question: string): Promise<TerminalInput> {
      // The question is written either way, so a run driven by a pipe leaves the
      // same transcript as one driven by a person.
      const early = unclaimed.shift();
      if (early !== undefined) {
        output.write(question);
        return { kind: 'typed', text: early };
      }

      if (closed) return { kind: 'ended' };

      const started = reading();
      return new Promise<TerminalInput>((resolve) => {
        waiting = resolve;
        started.setPrompt(question);
        started.prompt();
      });
    },

    async attach(program: AttachedProgram): Promise<Attached> {
      if (closed) {
        return { kind: 'unavailable', problem: 'the input has ended' };
      }
      if (input.isTTY !== true || input.setRawMode === undefined) {
        return {
          kind: 'unavailable',
          problem:
            'this input is not a terminal, and an interactive program needs one: ' +
            'run setup in a terminal to drive it from here',
        };
      }
      if (unclaimed.length > 0) {
        // A tty with a file behind it: `script -qec 'agentplex setup' < answers`
        // and every other harness that allocates a terminal and then feeds it.
        // `isTTY` cannot tell that apart from a person, and answers that arrived
        // before the questions can: a person types one line per prompt, so this
        // buffer is only ever non-empty when something is reading a script out.
        // A browser OAuth flow put in front of that waits forever for a code
        // nobody is going to paste.
        return {
          kind: 'unavailable',
          problem:
            'answers are arriving ahead of the questions, so this input is a script ' +
            'rather than a person',
        };
      }

      // Called on the stream and never pulled off it. `tty.ReadStream`'s own
      // `setRawMode` reaches for `this._handle`, so a bare `setRawMode(true)`
      // out of a local throws a `TypeError` about `_handle` — on a real
      // terminal, and only there.
      const setRawMode = (raw: boolean): void => void input.setRawMode?.(raw);

      // Given up rather than paused: see the note above. From here the input is
      // the program's, and the next question builds the next interface.
      stopReading();

      const decoder = new TextDecoder();
      const toProgram = (chunk: Uint8Array | string): void => {
        // Decoded as a stream, never chunk by chunk. A paste lands wherever the
        // kernel split it, which is regularly the middle of a UTF-8 code point,
        // and a decoder with no memory between reads replaces both halves with
        // U+FFFD. The seam takes keystrokes as a string because that is what a
        // person types; this is the one place bytes become one.
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (text.length > 0) program.write(text);
      };

      const toOperator = (chunk: Uint8Array): void => {
        // Bytes through untouched. This is a TUI drawing itself, not text.
        output.write(Buffer.from(chunk));
      };

      const resize = (): void => {
        program.resize(output.columns ?? FALLBACK_COLS, output.rows ?? FALLBACK_ROWS);
      };

      // The operator going away under the program: an ssh session that dropped,
      // a `^D` where the input is a pipe rather than a tty. In raw mode a `^D`
      // at a real terminal is byte 0x04 on its way to the child instead, which
      // is what makes this the disconnection case and not the "I am done" one.
      let inputEnded = (): void => undefined;
      const ended = new Promise<void>((resolve) => {
        inputEnded = resolve;
      });
      input.on('end', inputEnded);
      input.on('close', inputEnded);

      const unsubscribe = program.subscribe(toOperator);
      input.on('data', toProgram);
      output.on('resize', resize);
      setRawMode(true);
      input.resume();
      // Before the first keystroke: a TUI lays itself out on the size it is
      // told about, and one born at 80x24 on a wide terminal redraws over
      // whatever the operator was reading.
      resize();

      const outcome = await Promise.race([
        program.whenExited().then((): Attached => ({ kind: 'ended' })),
        ended.then((): Attached => ({ kind: 'abandoned' })),
      ]);

      // Everything above, undone in the reverse order, whichever way it ended.
      // The terminal belongs to the operator again after this line.
      setRawMode(false);
      input.pause();
      input.off('data', toProgram);
      input.off('end', inputEnded);
      input.off('close', inputEnded);
      output.off('resize', resize);
      unsubscribe();

      // An input that ended under the program is an input that has ended. There
      // is no interface to hear it from any more — this took the last one away —
      // so it is recorded here rather than waited for.
      if (outcome.kind === 'abandoned') closed = true;

      return outcome;
    },

    close(): void {
      closed = true;
      // Closed first: a readline that is still reading goes on consuming the
      // input whatever is done to the stream underneath it. An `attach` has
      // already given its interface up, and `unref` is still owed either way —
      // `resume` inside the attach referenced the handle as surely as readline
      // would have.
      stopReading();
      if (releasable(input)) input.unref();
      answer({ kind: 'ended' });
    },
  };
}

/**
 * Whether this input is one the event loop can be told to stop counting.
 *
 * `process.stdin` is, and it is the one that matters: a tty and a pipe are both
 * libuv handles that keep a process alive once they have been read. A stream
 * built in a test is not, and does not need to be — it ends.
 */
function releasable(stream: Readable): stream is Readable & { unref(): void } {
  return 'unref' in stream && typeof stream.unref === 'function';
}
