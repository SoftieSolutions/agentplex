/**
 * The terminal seam: the only way the wizard says anything or hears anything.
 *
 * Injected for the reason every other seam here is. A wizard that reached for
 * `process.stdin` would be a wizard that can only be tested by a person sitting
 * at a keyboard, and the interesting parts of it — what it does with a provider
 * that is on PATH and cannot report a version, what plan it builds out of the
 * answers — are exactly the parts nobody would then check. With the seam, a test
 * scripts the answers and reads the plan.
 *
 * Two decisions are worth naming.
 *
 * **The input ending is a value, not an exception.** A pipe that ran out, a `^D`,
 * `agentplexd setup < /dev/null`: all of them mean there is nobody there to
 * answer the next question, and the honest response is to stop having asked
 * nothing rather than to take a default on the operator's behalf. Every helper
 * below propagates it, and the wizard turns it into "there is nobody to ask" and
 * points at the unattended front end.
 *
 * **An answer is a claim.** It arrives from outside the program exactly as a
 * plan file does, so it goes through a parser that can say no, and a no is a
 * question asked again rather than a value nobody checked.
 */

export interface SetupTerminal {
  /** One line to the operator. The newline is the terminal's to add. */
  write(line: string): void;
  /**
   * Puts a question and waits for the answer.
   *
   * The prompt is written without a newline, so the cursor sits after it. Never
   * rejects: an input that has ended is an answer of its own kind.
   */
  ask(question: string): Promise<TerminalInput>;
}

export type TerminalInput =
  | { readonly kind: 'typed'; readonly text: string }
  /** There is nobody there: EOF, a closed pipe, a `^D`. Not an empty answer. */
  | { readonly kind: 'ended' };

/** An answer that was parsed, or the input ending before one arrived. */
export type Asked<T> =
  { readonly kind: 'answered'; readonly value: T } | { readonly kind: 'ended' };

/** What a parser makes of what somebody typed. A refusal is asked again. */
export type AnswerParse<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/**
 * One question, asked until it is answered or the input ends.
 *
 * The empty line is the whole reason the wizard is a wizard rather than a flag
 * wall: everything it can discover, it offers, and pressing return takes it. So
 * an empty answer is never passed to the parser — it is the offer being
 * accepted, and it cannot be refused by a parser that would have to have an
 * opinion about the value the wizard itself proposed.
 */
export async function askFor<T>(
  terminal: SetupTerminal,
  question: string,
  fallback: T,
  parse: (text: string) => AnswerParse<T>,
): Promise<Asked<T>> {
  for (;;) {
    const input = await terminal.ask(question);
    if (input.kind === 'ended') return { kind: 'ended' };

    const text = input.text.trim();
    if (text.length === 0) return { kind: 'answered', value: fallback };

    const parsed = parse(text);
    if (parsed.ok) return { kind: 'answered', value: parsed.value };

    // The refusal, and then the same question again. An answer discarded in
    // silence is how somebody ends up provisioning a machine they did not
    // describe and finding out later.
    terminal.write(parsed.problem);
  }
}

/** A line of text, whatever it says. Only emptiness means anything here. */
export function askText(
  terminal: SetupTerminal,
  question: string,
  fallback: string,
): Promise<Asked<string>> {
  return askFor(terminal, prompt(question, fallback), fallback, (text) => ({
    ok: true,
    value: text,
  }));
}

const YES = ['y', 'yes'];
const NO = ['n', 'no'];

export function askYesNo(
  terminal: SetupTerminal,
  question: string,
  fallback: boolean,
): Promise<Asked<boolean>> {
  return askFor(terminal, `${question} [${fallback ? 'Y/n' : 'y/N'}] `, fallback, (text) => {
    const answer = text.toLowerCase();
    if (YES.includes(answer)) return { ok: true, value: true };
    if (NO.includes(answer)) return { ok: true, value: false };
    return { ok: false, problem: `answer yes or no, not ${text}` };
  });
}

export interface Choice<T> {
  readonly value: T;
  /** What the operator types to pick it. */
  readonly name: string;
  /** One line saying what picking it means. Printed above the question. */
  readonly summary: string;
}

/**
 * A closed set of answers, each with the sentence that says what it means.
 *
 * The summaries are printed rather than left to a manual: the questions this
 * asks — which role this machine is, what to do about a provider that will not
 * answer a version probe — are ones an operator is entitled to make an informed
 * choice about at the moment they are asked.
 */
export async function askChoice<T>(
  terminal: SetupTerminal,
  question: string,
  choices: readonly Choice<T>[],
  fallback: Choice<T>,
): Promise<Asked<T>> {
  for (const choice of choices) terminal.write(`  ${choice.name} - ${choice.summary}`);

  return askFor(terminal, prompt(question, fallback.name), fallback.value, (text) => {
    const answer = text.toLowerCase();
    const chosen = choices.find((choice) => choice.name.toLowerCase() === answer);
    return chosen === undefined
      ? { ok: false, problem: `pick one of: ${choices.map((one) => one.name).join(', ')}` }
      : { ok: true, value: chosen.value };
  });
}

/** The offer, in the prompt, so that what return takes is never a guess. */
function prompt(question: string, fallback: string): string {
  return `${question} [${fallback}] `;
}
