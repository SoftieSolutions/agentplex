import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SetupTerminal, TerminalInput } from './setup-terminal.js';

/**
 * The real terminal, named in one place so nothing else has to reach for a
 * stream.
 *
 * The streams arrive as arguments rather than being read off `process`, for the
 * same reason the child environment does: the entrypoint is where this process's
 * own world is read, and a module that reaches for `process.stdin` is a module
 * that can only run inside a real one.
 *
 * The shape here is three gotchas rather than a preference, each verified at the
 * origin on Node 24.20 and each silent in the direction that loses an answer.
 *
 * - `readline`'s own `question` — the obvious way to write this — **never
 *   settles when the input ends while it is pending**. `agentplexd setup <
 *   /dev/null` would hang forever on the first question rather than reporting
 *   that there is nobody to ask, and so would a `^D` at any prompt.
 * - Racing `question` against the interface's `close` event does not fix that:
 *   when a line and the end of input arrive in the same tick, `close` resolves a
 *   microtask before the question does, and the race throws away an answer the
 *   operator actually typed. `line` and `close` are emitted in order by one
 *   emitter, so listening for both directly is the only arrangement in which
 *   "the operator typed this" reliably beats "the input has ended".
 * - A piped input is **read ahead of the questions**. `printf 'both\n8080\n' |
 *   agentplexd setup` emits both lines as they arrive whether or not anything is
 *   asking, so a terminal that only listens while a question is outstanding
 *   drops every answer that arrived early — silently, and answering the
 *   questions it did hear with the wrong lines. Lines nobody has asked for yet
 *   are therefore kept, and a question takes the oldest one before it waits.
 *
 * `setPrompt`/`prompt` is what puts the question on the output, so readline
 * knows the prompt's width and line editing on a real terminal redraws
 * correctly.
 *
 * The fourth is about the end rather than the middle, and it is the one a stream
 * cannot show you. **An input that has been read holds the event loop open until
 * it ends, and a terminal never ends.** A piped run exits because the pipe ran
 * out, which is why every test above it passes; a person at a tty gets a finished
 * wizard and a shell prompt that never comes back. Measured at the origin on the
 * same Node: after the last question, `close()` on the interface releases
 * readline's listeners and pauses the input and the process still does not exit,
 * and `pause()` on the input does not help either — the handle stays referenced.
 * `unref` is what releases it. So `close` does both, and it is on the returned
 * type rather than on `SetupTerminal`: closing a terminal is a property of the
 * one that owns an interface, not of the abstraction the wizard asks questions
 * through, and whoever opened it is the one that closes it.
 *
 * The interface is created at the first question rather than at construction for
 * the same reason. `createInterface` attaches a `data` listener immediately, so a
 * terminal that is built and never asked anything — which is every
 * `agentplexd setup --plan` run — would resume stdin and hang a replay that has
 * nobody at it at all.
 */

export interface NodeSetupTerminalStreams {
  readonly input: Readable;
  readonly output: Writable;
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

export function createNodeSetupTerminal({
  input,
  output,
}: NodeSetupTerminalStreams): NodeSetupTerminal {
  /** Lines that arrived before anything asked for them. Oldest first. */
  const unclaimed: string[] = [];
  let waiting: ((input: TerminalInput) => void) | null = null;
  let readline: Interface | null = null;
  let closed = false;

  const answer = (input: TerminalInput): boolean => {
    const resolve = waiting;
    if (resolve === null) return false;
    waiting = null;
    resolve(input);
    return true;
  };

  /** Built once, at the first question, because building one starts a read. */
  const reading = (): Interface => {
    if (readline !== null) return readline;

    const started = createInterface({ input, output });
    readline = started;

    started.on('line', (text: string) => {
      if (!answer({ kind: 'typed', text })) unclaimed.push(text);
    });

    started.once('close', () => {
      closed = true;
      answer({ kind: 'ended' });
    });

    return started;
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

    close(): void {
      closed = true;
      // Closed first: a readline that is still reading goes on consuming the
      // input whatever is done to the stream underneath it.
      readline?.close();
      readline = null;
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
