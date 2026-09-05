import { createInterface } from 'node:readline';
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
 */

export interface NodeSetupTerminalStreams {
  readonly input: Readable;
  readonly output: Writable;
}

export function createNodeSetupTerminal({
  input,
  output,
}: NodeSetupTerminalStreams): SetupTerminal {
  const readline = createInterface({ input, output });

  /** Lines that arrived before anything asked for them. Oldest first. */
  const unclaimed: string[] = [];
  let waiting: ((input: TerminalInput) => void) | null = null;
  let closed = false;

  const answer = (input: TerminalInput): boolean => {
    const resolve = waiting;
    if (resolve === null) return false;
    waiting = null;
    resolve(input);
    return true;
  };

  readline.on('line', (text: string) => {
    if (!answer({ kind: 'typed', text })) unclaimed.push(text);
  });

  readline.once('close', () => {
    closed = true;
    answer({ kind: 'ended' });
  });

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

      return new Promise<TerminalInput>((resolve) => {
        waiting = resolve;
        readline.setPrompt(question);
        readline.prompt();
      });
    },
  };
}
