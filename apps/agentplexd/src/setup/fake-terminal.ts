import type { Attached, AttachedProgram, SetupTerminal, TerminalInput } from './setup-terminal.js';

/**
 * A terminal with an operator already at it.
 *
 * A real implementation of the seam and not a mock: the answers are typed
 * ahead, the questions and the output are kept, and a test asserts on the plan
 * the wizard built rather than on which methods it called. When the script runs
 * out the input has ended, which is exactly what a `^D` is — so a test that
 * scripts one answer too few exercises the path a wizard takes when nobody is
 * there to answer, instead of hanging.
 *
 * An attach is the same idea one layer down. The operator's keystrokes at the
 * program are scripted the way their answers are, everything the program printed
 * is kept, and the attach ends when the program does — so a test asserts that
 * the login's own output reached the operator and that what they typed reached
 * the login, rather than that `attach` was called.
 */
export interface FakeTerminalOptions {
  /** What the operator types, in order. An empty line takes the offer. */
  readonly answers?: readonly string[];
  /**
   * What the operator types at a program the terminal has been handed to, in
   * order, one entry per attach. Nothing typed is a login the operator finished
   * in a browser, which is the common case for an OAuth flow.
   */
  readonly keystrokes?: readonly string[];
  /**
   * Makes the terminal refuse to hand itself over, in the words it would use.
   *
   * `agentplexd setup` behind a pipe: there is a wizard, because its answers
   * arrived on stdin, and there is no terminal to put a login in front of.
   */
  readonly notATerminal?: string;
  /**
   * Ends the attach on the operator's input rather than on the program: a `^D`
   * at a login prompt, or an ssh session that went away mid-flow. The program is
   * still running when the terminal comes back, which is the whole difference.
   */
  readonly abandons?: boolean;
  /** The size the operator's terminal reports when it lends itself out. */
  readonly size?: { readonly cols: number; readonly rows: number };
}

export interface FakeTerminal extends SetupTerminal {
  /** Every prompt put to the operator, in order, exactly as it was rendered. */
  readonly questions: readonly string[];
  /** Every line written, in order. */
  readonly lines: readonly string[];
  /** Everything written and asked, joined, for a test that only wants a substring. */
  readonly transcript: string;
  /** Answers not used. A wizard that asked less than the test scripted. */
  readonly unanswered: number;
  /** Everything an attached program printed, decoded, in order. */
  readonly attachedOutput: readonly string[];
  /** How many programs the terminal was handed to. */
  readonly attaches: number;
}

export function createFakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const answers = [...(options.answers ?? [])];
  const keystrokes = [...(options.keystrokes ?? [])];
  const questions: string[] = [];
  const lines: string[] = [];
  const attachedOutput: string[] = [];
  let attaches = 0;

  return {
    questions,
    lines,
    attachedOutput,

    get attaches() {
      return attaches;
    },

    get transcript() {
      return [...lines, ...questions, ...attachedOutput].join('\n');
    },

    get unanswered() {
      return answers.length;
    },

    write(line: string): void {
      lines.push(line);
    },

    async ask(question: string): Promise<TerminalInput> {
      questions.push(question);
      const next = answers.shift();
      return next === undefined ? { kind: 'ended' } : { kind: 'typed', text: next };
    },

    async attach(program: AttachedProgram): Promise<Attached> {
      attaches += 1;
      if (options.notATerminal !== undefined) {
        return { kind: 'unavailable', problem: options.notATerminal };
      }

      const decoder = new TextDecoder();
      const unsubscribe = program.subscribe((chunk) => {
        attachedOutput.push(decoder.decode(chunk));
      });

      const size = options.size ?? { cols: 80, rows: 24 };
      program.resize(size.cols, size.rows);

      const typed = keystrokes.shift();
      if (typed !== undefined) program.write(typed);

      if (options.abandons === true) {
        unsubscribe();
        return { kind: 'abandoned' };
      }

      await program.whenExited();
      unsubscribe();
      return { kind: 'ended' };
    },
  };
}
