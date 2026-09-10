import type { SetupTerminal, TerminalInput } from './setup-terminal.js';

/**
 * A terminal with an operator already at it.
 *
 * A real implementation of the seam and not a mock: the answers are typed
 * ahead, the questions and the output are kept, and a test asserts on the plan
 * the wizard built rather than on which methods it called. When the script runs
 * out the input has ended, which is exactly what a `^D` is — so a test that
 * scripts one answer too few exercises the path a wizard takes when nobody is
 * there to answer, instead of hanging.
 */
export interface FakeTerminalOptions {
  /** What the operator types, in order. An empty line takes the offer. */
  readonly answers?: readonly string[];
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
}

export function createFakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const answers = [...(options.answers ?? [])];
  const questions: string[] = [];
  const lines: string[] = [];

  return {
    questions,
    lines,

    get transcript() {
      return [...lines, ...questions].join('\n');
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
  };
}
