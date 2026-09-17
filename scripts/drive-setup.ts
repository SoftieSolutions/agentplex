import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * An operator at a terminal, for the one check that has a machine to run on.
 *
 * `install.sh` ends by handing the terminal to `agentplex setup`, and that
 * handover is the one seam in the bootstrap nothing has ever exercised: CI
 * proves the script through to `doctor` with `--no-setup`, and the wizard is
 * proved against a pty in `apps/cli/src/commands/setup/setup-exit.integration.test.ts`,
 * on a machine that was never installed onto. Both halves exist and nothing has
 * crossed them, because a `RUN` line has no terminal and the script declines to
 * open a wizard without one -- which is exactly the branch that would hide a
 * broken handover.
 *
 * So this opens one. It is a pty, a real `install.sh`, a real wizard and
 * whatever exit code that run really produced, printed for the `RUN` lines after
 * it to assert against.
 *
 * ## Why a Node script and not `expect`
 *
 * `expect` and `script` are packages the check would have to install, and every
 * package in `bootstrap-check` is there to model something the operator's
 * machine already had -- a trust store, curl, sudo, systemd. A tcl interpreter
 * models nothing, and it would also be the second implementation in this
 * repository of "recognise a prompt and type at it".
 *
 * This is the first one, kept: the rule that decides what to type is the one
 * `setup-exit.integration.test.ts` argues for, and the pty comes from the seam
 * the server opens its sessions through. Neither is installed for the check --
 * they arrive on the machine because a server install puts them there, which
 * makes loading them one more assertion rather than one more dependency.
 *
 * ## What it does not decide
 *
 * Nothing here asserts. It drives a run and prints what happened; the `RUN`
 * lines in the Dockerfile are the assertions, as they are for every other step
 * of that stage. Its own exit code says only whether it managed to drive a run
 * to an end -- a wizard that exits 2 is a successful drive and a failed check,
 * and those are two different questions.
 */

/** Where the pty seam is, and the run to drive on it. */
export interface Invocation {
  /**
   * The module to load the pty seam from, as an absolute path.
   *
   * Passed in rather than imported, because there is no workspace on the
   * machine this runs on: the seam is the copy bundled into the installed
   * command, and where that lands is a fact about the install, which is the
   * Dockerfile's to state.
   */
  readonly ptyModule: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How long a silent child is given before the run is called stuck.
 *
 * A bound on silence rather than on the whole run: this drives an install that
 * downloads a runtime and compiles a native addon, so there is no honest total
 * to pick, and the failure worth catching is a question nothing here knows how
 * to answer -- where the transcript stops and nobody types. The message names
 * the prompt it stopped on, which is the whole of the diagnosis.
 *
 * Five minutes because the run this drives re-installs a package with a native
 * addon in it, and npm compiling node-pty is a minute or more of a child that
 * says nothing. A bound that a real compile can trip is a flaky check; a bound
 * this long still catches an unanswered question inside one build.
 */
const SILENCE_MS = 300_000;

/**
 * How long the whole run gets, however talkative it is.
 *
 * The bound above watches for a child that stopped; this one watches for a
 * child that never will. A wizard that asks the same question again on every
 * turn -- see `ANOTHER_PATH_QUESTION` -- is never silent for a second, so the
 * only thing that can end it is a clock over the run rather than over the gaps
 * in it. Ten minutes is longer than any honest run of this: the install it
 * drives takes about one, and the slowest part of that is a compile the layer
 * above has already done once.
 */
const DEADLINE_MS = 600_000;

/**
 * The size the child is told its terminal is.
 *
 * Wider than a person's 80 because readline does its own arithmetic with this
 * number: a question whose default is an absolute path is a long line, and a
 * terminal it does not fit on is redrawn by moving the cursor up and down
 * several rows rather than along one. Everything below still reads it -- the
 * moves are stripped -- but a prompt that is one line in the transcript is a
 * prompt the log shows as the question it was.
 */
const COLS = 200;
const ROWS = 50;

/** What a person presses to answer a question. */
const RETURN = '\r';

/** What a terminal starts a cursor move with. */
const ESCAPE = '\u001b';

/**
 * Everything a terminal writes to put the cursor somewhere, gone.
 *
 * Built rather than written as a literal: a control character in a regular
 * expression is banned in this repository, and it is banned for the reason that
 * makes this one worth a comment -- nobody can see it in the source.
 *
 * `?` is in the class because hiding and showing a cursor is a private-mode
 * sequence, and a readline that drew one would otherwise leave `[?25l` in a log
 * somebody has to read.
 */
const CURSOR = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'g');

/**
 * The wizard's first line, and the point from which a prompt on this terminal is
 * the wizard's to answer.
 *
 * Nothing is typed before it. Everything above the handover is an installer
 * talking -- an npm that draws a progress bar, a tarball being unpacked -- and a
 * rule that recognises "a line ending in a bracket and a space" would eventually
 * find one there and type into it.
 */
export const WIZARD_BANNER = 'agentplex setup';

/**
 * The offer to log a provider in, which this machine has to turn down.
 *
 * A login is a browser OAuth flow. There are no credentials in a build and there
 * is no browser, so an operator here declines it -- and the check's ceiling is
 * exactly that: every state short of `ready` is reachable from a container, and
 * `ready` is not.
 *
 * Written as the shape of the question rather than as one provider's, because
 * the answer is about the machine and not about who is asking: nothing a build
 * container holds can finish any provider's login, and a provider registered
 * later must not be the one that hangs this on a browser nobody is at.
 */
const LOGIN_OFFER = { starts: 'Log ', ends: ' in now? ' } as const;

export function isALoginOffer(prompt: string): boolean {
  return prompt.startsWith(LOGIN_OFFER.starts) && prompt.includes(LOGIN_OFFER.ends);
}

/**
 * The question this machine has to answer yes to.
 *
 * The plan is what the run is for. It defaults to no because saving a file is
 * not something a wizard should assume, and the artifact is the thing this check
 * reads back.
 */
const SAVE_QUESTION = 'Save this plan to a file?';

/**
 * The question that would turn this wizard into a loop, and the reason the rule
 * cannot simply take the default.
 *
 * `offerToSave` never writes over a file that is already there: it says the file
 * was left alone, offers the same path again, and asks whether to try another
 * one -- defaulting to yes. On a machine where `setup-plan.json` already exists,
 * taking that default is a run that goes round for ever, printing a line every
 * turn. The bound on silence cannot see that, because it is not silent; the
 * wall-clock bound can, and this is what stops it needing to.
 *
 * So the answer is no. This check saves the plan once or says out loud that it
 * could not, and either is a fact the `RUN` lines can read.
 */
const ANOTHER_PATH_QUESTION = 'Try another path?';

/**
 * The offer a provider this machine does not have is made, and the one offer
 * this operator turns down.
 *
 * Taking it would have the check npm-install a provider out of the public
 * registry to reach a login that is not its, on a box whose point is that it
 * installed nothing anybody did not put there. The `claude` on this machine's
 * PATH is the one under test, it is found, and what it is offered is adoption.
 */
const INSTALL_OFFER = '[install] ';

/**
 * How every question this wizard asks ends: the default it is offering, in
 * brackets, and the space the cursor sits after.
 */
const DEFAULT_OFFERED = '] ';

/**
 * What a person sitting at this terminal would type at the question in front of
 * them, or nothing if they would not recognise it as a question.
 *
 * Answering the question rather than counting the questions, for the reason
 * `setup-exit.integration.test.ts` argues at length: a question this file did
 * not know about is a question it can still answer, rather than an answer that
 * lands one prompt early and a run that hangs behind it. A provider registered
 * later adds a question here and changes nothing.
 *
 * The three named questions come first because they are questions too: all
 * three end in `] ` like every other one, and the default rule would take the
 * default at each.
 */
export function asAnOperatorWould(prompt: string): string | undefined {
  // A question is only a question once its default and the space after it have
  // arrived. Recognising one by its opening words alone would answer a prompt
  // the child is still drawing -- and an answer that arrives before its question
  // is exactly what `node-setup-terminal.ts` reads as a script behind a
  // terminal, which is the one thing this must never look like. A chunk
  // boundary falls wherever the kernel puts it, so this is not hypothetical.
  if (!prompt.endsWith(DEFAULT_OFFERED)) return undefined;

  if (isALoginOffer(prompt)) return `n${RETURN}`;
  if (prompt.startsWith(SAVE_QUESTION)) return `y${RETURN}`;
  if (prompt.startsWith(ANOTHER_PATH_QUESTION)) return `n${RETURN}`;
  if (prompt.endsWith(INSTALL_OFFER)) return `skip${RETURN}`;
  return RETURN;
}

/**
 * Everything the child has written, as text a person and a `grep` can read.
 *
 * Two transformations, and both are the terminal's own doing rather than the
 * program's. The cursor moves go because they are a readline drawing itself.
 * The carriage return of every line ending goes because a tty turns a newline
 * into one on the way out, so a transcript kept verbatim is a file whose every
 * line ends one character before it appears to -- and the `RUN` lines that read
 * this log anchor on the ends of lines.
 *
 * A carriage return that is not part of a line ending is left where it is. It
 * means something: it is a program going back to the start of the line it is
 * on.
 */
export function written(text: string): string {
  return text.replaceAll(CURSOR, '').replaceAll('\r\n', '\n');
}

/**
 * The question the child is sitting on, or nothing if it is still talking.
 *
 * A prompt is written without a newline, so it is whatever the child wrote after
 * the last one: `Role [server] `, `Apply it to this machine? [Y/n] `.
 */
export function pendingPrompt(text: string): string {
  const last = text.split(/[\r\n]/).at(-1) ?? '';
  return last.trim().length === 0 ? '' : last;
}

/**
 * The seam, as much of it as this file uses.
 *
 * Declared here rather than imported, because the import is a path this program
 * is handed at runtime and TypeScript cannot see it. The shape is checked
 * against the loaded module before anything is opened, so a seam that moved
 * fails saying so rather than as a `TypeError` mid-run.
 */
interface Pty {
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(
    listener: (exit: { readonly exitCode: number; readonly signal: number | null }) => void,
  ): void;
  write(input: string): void;
  kill(): void;
}

interface PtyFactory {
  open(request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cols: number;
    readonly rows: number;
    readonly term: string;
  }): Pty;
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const PTY_FLAG = '--pty';
const END_OF_FLAGS = '--';

function usage(): string {
  return `Usage: node drive-setup.ts ${PTY_FLAG} <module> ${END_OF_FLAGS} <command> [argument ...]`;
}

/** The command line, refused rather than assumed. */
export function parseInvocation(argv: readonly string[]): Parsed<Invocation> {
  if (argv[0] !== PTY_FLAG)
    return { ok: false, problem: `the first argument has to be ${PTY_FLAG}` };

  const ptyModule = argv[1];
  if (ptyModule === undefined || ptyModule.length === 0) {
    return { ok: false, problem: `${PTY_FLAG} takes the path of the module to load the seam from` };
  }

  if (argv[2] !== END_OF_FLAGS) {
    return { ok: false, problem: `the run to drive comes after ${END_OF_FLAGS}` };
  }

  const command = argv[3];
  if (command === undefined)
    return { ok: false, problem: `there is no command after ${END_OF_FLAGS}` };

  return { ok: true, value: { ptyModule, command, args: argv.slice(4) } };
}

/** The pty seam out of the install this check just made, or the reason it is not there. */
async function loadPtyFactory(module: string): Promise<Parsed<PtyFactory>> {
  let loaded: unknown;
  try {
    loaded = await import(module);
  } catch (cause) {
    return { ok: false, problem: `cannot load ${module}: ${String(cause)}` };
  }

  if (typeof loaded !== 'object' || loaded === null || !('nodePtyFactory' in loaded)) {
    return { ok: false, problem: `${module} exports no nodePtyFactory` };
  }

  const factory = loaded.nodePtyFactory;
  if (
    typeof factory !== 'object' ||
    factory === null ||
    typeof (factory as PtyFactory).open !== 'function'
  ) {
    return { ok: false, problem: `the nodePtyFactory in ${module} has no open()` };
  }

  return { ok: true, value: factory as PtyFactory };
}

/**
 * Everything this process was started with, as the seam wants it.
 *
 * The whole environment and not a chosen subset: the point of the check is that
 * a run started the way the Dockerfile starts one reaches a wizard, and a
 * driver that curated `PATH`, `HOME` or `AGENTPLEX_PACKAGE` would be testing an
 * environment nobody has.
 */
function environment(): Readonly<Record<string, string>> {
  const pairs = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(pairs);
}

/**
 * Everything the driver carries from one chunk of output to the next.
 *
 * Two facts, and both are about the transcript rather than about the clock.
 */
export interface Typing {
  /**
   * Whether the wizard has started talking.
   *
   * Nothing is typed before it has. Everything above the handover is an
   * installer talking, and a rule that recognises "a line ending in a bracket
   * and a space" would eventually find one in an npm progress bar and type into
   * it.
   */
  readonly armed: boolean;
  /**
   * How much the child had written before the question that was last answered.
   *
   * The text only ever grows, so every new question sits further along than the
   * one before it and a redraw of the current one sits at exactly this offset.
   * `-1` is a run that has answered nothing.
   */
  readonly answeredAfter: number;
}

/** A driver that has read nothing yet. */
export const BEFORE_THE_WIZARD: Typing = { armed: false, answeredAfter: -1 };

/** What to do about everything the child has written so far. */
export interface Keystrokes {
  /** What to type, or `null` for nothing to type yet. */
  readonly type: string | null;
  /** The question `type` answers, as it appeared, or `null` when nothing is typed. */
  readonly question: string | null;
  /** What to carry into the next chunk. */
  readonly state: Typing;
}

/** Nothing to type, and nothing learned. */
function waiting(state: Typing): Keystrokes {
  return { type: null, question: null, state };
}

/**
 * The whole of the decision, as a function of what has been written.
 *
 * Pure, and deliberately so: everything this program gets wrong it gets wrong
 * here -- typing before the wizard is listening, typing twice at a redraw,
 * taking a default that loops -- and none of it needs a pty to be shown. `drive`
 * below is the plumbing that feeds this and writes what it says.
 *
 * It takes the transcript as `written` leaves it, because the offsets it
 * remembers are offsets into that.
 */
export function whatToType(text: string, state: Typing): Keystrokes {
  const armed = state.armed || text.includes(WIZARD_BANNER);
  if (!armed) return waiting({ ...state, armed });

  const question = pendingPrompt(text);
  if (question.length === 0) return waiting({ ...state, armed });

  const type = asAnOperatorWould(question);
  if (type === undefined) return waiting({ ...state, armed });

  // A question is answered once where it stands. Readline redraws a line it is
  // sitting on by moving the cursor, which changes nothing once the moves are
  // taken out -- so "the same prompt at the same offset" is a redraw, and typing
  // at it again would put the second line in front of the *next* question.
  const answeredAfter = text.length - question.length;
  if (answeredAfter === state.answeredAfter) return waiting({ ...state, armed });

  return { type, question, state: { armed, answeredAfter } };
}

/** Why the driver stopped waiting, when it was not the child that ended. */
interface GaveUp {
  readonly why: string;
  /** The question it was sitting on when it gave up. */
  readonly prompt: string;
}

/** What a driven run leaves behind. */
interface Driven {
  readonly exitCode: number;
  readonly signal: number | null;
  /** The questions it answered, in the order it answered them. */
  readonly asked: readonly string[];
  /** Set when the driver gave up rather than the child ending. */
  readonly gaveUp: GaveUp | null;
}

/**
 * Runs the command on a pty and answers the wizard, one question at a time.
 *
 * One at a time and never all at once. A person types one line per prompt and
 * setup can tell the difference -- answers that arrived ahead of the questions
 * are how `node-setup-terminal.ts` recognises a script behind a terminal -- and
 * a run driven that way would be refused the one step this check most wants to
 * reach honestly.
 *
 * **The rule is also the trigger.** There is no clock deciding when to type: a
 * prompt the rule recognises is itself the signal that the child is waiting,
 * because every wizard question is written as `<question> [<default>] ` and
 * parked on without a newline. Both bounds are failure detectors and neither is
 * a pacer.
 *
 * What to type is `whatToType`'s to decide. This opens the pty, feeds it the
 * transcript, writes what it says, and holds the two clocks that end a run
 * nothing else would.
 *
 * The transcript goes out as it arrives, a line at a time. A `RUN` step that
 * printed nothing until it finished would be a build that looks hung for the
 * several minutes an install takes, and the same step's log is the only thing
 * anybody has to read when it really does hang. Whole lines rather than every
 * chunk, because a cursor move can be split across two reads and half of one
 * stripped is the other half left in the log.
 */
function drive(factory: PtyFactory, invocation: Invocation): Promise<Driven> {
  const pty = factory.open({
    command: invocation.command,
    args: invocation.args,
    cwd: process.cwd(),
    env: environment(),
    cols: COLS,
    rows: ROWS,
    term: 'xterm-256color',
  });

  const chunks: string[] = [];
  const asked: string[] = [];
  const decoder = new TextDecoder();
  let state = BEFORE_THE_WIZARD;

  // How much of the stripped transcript has already been printed.
  let printed = 0;

  return new Promise<Driven>((resolve) => {
    const seen = (): string => written(chunks.join(''));

    const flush = (text: string, toTheEnd: boolean): void => {
      const upTo = toTheEnd ? text.length : text.lastIndexOf('\n') + 1;
      if (upTo <= printed) return;
      process.stdout.write(text.slice(printed, upTo));
      printed = upTo;
    };

    let finish = (driven: Driven): void => {
      finish = () => undefined;
      clearTimeout(quiet);
      clearTimeout(deadline);
      flush(seen(), true);
      resolve(driven);
    };

    // Killed and reported rather than left running: this process is about to
    // stop being anybody's parent, and a child holding a pty after it would
    // outlive the `RUN` step that started it.
    const giveUp = (why: string): void => {
      const prompt = pendingPrompt(seen());
      pty.kill();
      finish({
        exitCode: -1,
        signal: null,
        asked,
        gaveUp: {
          why,
          prompt: prompt.length === 0 ? '(nothing: the child was mid-line)' : prompt,
        },
      });
    };

    const silence = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => giveUp(`nothing was written for ${SILENCE_MS / 1000}s`), SILENCE_MS);

    let quiet = silence();
    const deadline = setTimeout(
      () => giveUp(`the run was still going after ${DEADLINE_MS / 1000}s`),
      DEADLINE_MS,
    );

    pty.onData((chunk) => {
      clearTimeout(quiet);
      quiet = silence();

      chunks.push(decoder.decode(chunk, { stream: true }));
      const text = seen();
      flush(text, false);

      const keystrokes = whatToType(text, state);
      state = keystrokes.state;
      if (keystrokes.type === null || keystrokes.question === null) return;
      asked.push(keystrokes.question.trim());
      pty.write(keystrokes.type);
    });

    pty.onExit((exit) => {
      finish({ exitCode: exit.exitCode, signal: exit.signal, asked, gaveUp: null });
    });
  });
}

/**
 * A run, driven, and everything it did printed for the `RUN` lines that read
 * this log.
 *
 * Its exit code says only whether a run was driven to an end. A wizard that
 * exited 2 is a successful drive and a failed check, and those are two
 * different questions; a driver that gave up never reached either.
 */
async function main(): Promise<number> {
  const say = (line: string): void => void process.stdout.write(`${line}\n`);

  const invocation = parseInvocation(process.argv.slice(2));
  if (!invocation.ok) {
    say(`drive-setup: ${invocation.problem}`);
    say(usage());
    return 1;
  }

  const factory = await loadPtyFactory(invocation.value.ptyModule);
  if (!factory.ok) {
    say(`drive-setup: ${factory.problem}`);
    return 1;
  }

  const driven = await drive(factory.value, invocation.value);

  say('');
  say('drive-setup: the questions it answered, in order:');
  for (const question of driven.asked) say(`  ${question}`);

  if (driven.gaveUp !== null) {
    say(
      `drive-setup: gave up -- ${driven.gaveUp.why}. The last prompt was: ${driven.gaveUp.prompt}`,
    );
    return 1;
  }

  // The line every assertion after this one reads. It is printed for a run that
  // ended badly as readily as for one that ended well: which code the run
  // deserved is the Dockerfile's question, and answering it here would put the
  // check in the harness.
  say(`drive-setup: the run exited ${driven.exitCode}, signal ${String(driven.signal)}`);
  return 0;
}

// Imported by its test; executed by the `RUN` line in `bootstrap-check`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
