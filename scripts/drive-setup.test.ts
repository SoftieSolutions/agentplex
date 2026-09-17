import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asAnOperatorWould,
  BEFORE_THE_WIZARD,
  parseInvocation,
  pendingPrompt,
  whatToType,
  WIZARD_BANNER,
  written,
} from './drive-setup.js';

/**
 * The driver's decisions, against transcripts three real runs produced.
 *
 * Everything this program can get wrong it gets wrong in a pure function --
 * typing before the wizard is listening, typing twice into a redraw, taking a
 * default that loops -- and none of it needs a pty to show. The pty is the part
 * `bootstrap-check` exercises, on a machine, once per build; this is the part a
 * laptop can hold every time.
 *
 * Every string the rules are asked about is lifted out of a capture, and the
 * question texts this file names are asserted to occur in one before they are
 * used -- so a wizard that rewords a question fails here as a question that is
 * no longer there, rather than silently as a rule that no longer matches
 * anything.
 */

/** Everything the bootstrap check's own run wrote, copied out of the image. */
const BOOTSTRAP = 'bootstrap-wizard-transcript.txt';

/**
 * The raw bytes of a pty, with nothing taken out of them.
 *
 * The capture above cannot stand in for this one: it is what the driver
 * *printed*, so its cursor moves and line endings have already been through the
 * function under test. This is a recording of the same wizard on a real pty
 * before any of that, which is the only thing that can show `written` working.
 */
const RAW = 'wizard-raw-terminal.txt';

/**
 * A run against a machine that had already saved a plan.
 *
 * The case that made a wall-clock bound necessary. Setup will not write over an
 * existing plan: it says so, offers the path again, and asks whether to try
 * another one with yes as the default. Taking that default is a wizard that
 * never ends and never goes quiet.
 */
const PLAN_ALREADY_SAVED = 'wizard-plan-already-saved.txt';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8');
}

/** What a terminal starts a cursor move with. */
const ESCAPE = '\u001b';

/** What a person presses to answer a question. */
const RETURN = '\r';

/**
 * The questions these runs asked, spelled as they appeared on the terminal.
 *
 * Named here and checked against the captures below, so that they are locators
 * into real output rather than expectations somebody typed.
 */
const ASKED = {
  role: 'Role [server] ',
  port: 'Server port [8081] ',
  adopt: 'claude [adopt] ',
  install: 'codex [install] ',
  apply: 'Apply it to this machine? [Y/n] ',
  login: 'Log claude in now? [Y/n] ',
  save: 'Save this plan to a file? [y/N] ',
} as const;

/** The one question the bootstrap run never reached, from the run that did. */
const ANOTHER_PATH = 'Try another path? [Y/n] ';

/**
 * A capture, replayed through the decision one character at a time.
 *
 * A character at a time because that is the worst a pty can do: a chunk
 * boundary falls wherever the kernel put it, including in the middle of a
 * question, and a rule that only works on whole reads is a rule that works
 * until the machine is busy. What comes back is the questions the replay
 * answered.
 */
function replay(transcript: string): readonly string[] {
  let state = BEFORE_THE_WIZARD;
  const asked: string[] = [];

  for (let end = 1; end <= transcript.length; end += 1) {
    const keystrokes = whatToType(transcript.slice(0, end), state);
    state = keystrokes.state;
    if (keystrokes.question !== null) asked.push(keystrokes.question.trim());
  }

  return asked;
}

/**
 * The questions the run itself said it answered, read off the end of its own
 * transcript.
 *
 * This is what makes the replay an assertion rather than a second opinion: the
 * expectation is not written here, it is the list the real run printed when it
 * had finished.
 */
function questionsRecordedIn(transcript: string): readonly string[] {
  const marker = 'drive-setup: the questions it answered, in order:\n';
  const at = transcript.indexOf(marker);
  expect(at, 'the capture has no record of what it answered').toBeGreaterThan(0);

  return transcript
    .slice(at + marker.length)
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.slice(2));
}

describe('the questions these captures asked', () => {
  it('are the ones this file names', () => {
    const transcript = fixture(BOOTSTRAP);
    for (const question of Object.values(ASKED)) expect(transcript).toContain(question);
    expect(fixture(PLAN_ALREADY_SAVED)).toContain(ANOTHER_PATH);
  });
});

describe('what a terminal wrote, as text', () => {
  it('has the cursor moves a readline drew itself with taken out', () => {
    const raw = fixture(RAW);
    // The capture is only evidence if it caught some.
    expect(raw).toContain(`${ESCAPE}[`);
    expect(written(raw)).not.toContain(ESCAPE);
  });

  it('ends a line the way a file does rather than the way a tty does', () => {
    const raw = fixture(RAW);
    expect(raw).toContain('Looking at this machine.\r\n');
    expect(written(raw).split('\n')).toContain('Looking at this machine.');
  });

  it('leaves the carriage return an answer was echoed with', () => {
    // The prompt line is the one place a bare carriage return means something:
    // it is readline putting the cursor back before it moves on, and a
    // transcript that dropped it would show the answer nowhere.
    expect(written(fixture(RAW))).toContain(`Role [hub] ${RETURN}`);
  });
});

describe('the question a run is sitting on', () => {
  it('is whatever was written after the last line ending', () => {
    const raw = fixture(RAW);
    const at = raw.indexOf('Role [hub] ');
    expect(at).toBeGreaterThan(0);
    // Cut where the child stopped writing and waited: everything up to the
    // carriage return readline echoed the answer with.
    expect(pendingPrompt(written(raw.slice(0, raw.indexOf(RETURN, at))))).toBe('Role [hub] ');
  });

  it('is nothing while the child is still talking', () => {
    const raw = fixture(RAW);
    const line = 'Looking at this machine.\r\n';
    expect(pendingPrompt(written(raw.slice(0, raw.indexOf(line) + line.length)))).toBe('');
  });
});

describe('before the wizard is the one asking', () => {
  it('is not armed until those words have been written', () => {
    const transcript = fixture(BOOTSTRAP);
    // Twice in a real run: install.sh reports the command it is about to start,
    // and then that command says its own name. Arming at the first costs
    // nothing -- a report line ends in a newline, and nothing is typed until a
    // question is written and parked on -- and waiting for the second would be
    // this file knowing which of two identical strings install.sh printed.
    const banner = transcript.indexOf(WIZARD_BANNER);
    expect(banner).toBeGreaterThan(0);
    expect(transcript.lastIndexOf(WIZARD_BANNER)).toBeGreaterThan(banner);

    expect(whatToType(transcript.slice(0, banner), BEFORE_THE_WIZARD).state.armed).toBe(false);
    expect(
      whatToType(transcript.slice(0, banner + WIZARD_BANNER.length), BEFORE_THE_WIZARD).state.armed,
    ).toBe(true);
  });

  it('types nothing at a question it has not been handed', () => {
    const transcript = fixture(BOOTSTRAP);
    const parkedOn = transcript.slice(0, transcript.indexOf(ASKED.role) + ASKED.role.length);

    // The same output with everything down to the handover dropped. It is still
    // this run's text and it still ends on a real question; what it no longer
    // has is the banner, which is the state the driver is in while an npm is
    // drawing a progress bar at it.
    const noBanner = parkedOn.slice(parkedOn.lastIndexOf(WIZARD_BANNER) + WIZARD_BANNER.length);
    expect(noBanner).not.toContain(WIZARD_BANNER);
    expect(whatToType(noBanner, BEFORE_THE_WIZARD)).toMatchObject({ type: null, question: null });

    expect(whatToType(parkedOn, BEFORE_THE_WIZARD)).toMatchObject({
      type: RETURN,
      question: ASKED.role,
    });
  });

  it('never types into anything above the handover', () => {
    const transcript = fixture(BOOTSTRAP);
    expect(replay(transcript.slice(0, transcript.indexOf(WIZARD_BANNER)))).toEqual([]);
  });
});

describe('a captured run, replayed', () => {
  it('answers the questions it really answered, in the order it really answered them', () => {
    const transcript = fixture(BOOTSTRAP);
    expect(replay(transcript)).toEqual(questionsRecordedIn(transcript));
  });

  it('answers a redraw once', () => {
    const asked = replay(fixture(BOOTSTRAP));
    expect(new Set(asked).size, asked.join(' | ')).toBe(asked.length);
  });

  it('takes a machine that had a plan already to an end', () => {
    const transcript = fixture(PLAN_ALREADY_SAVED);
    expect(replay(transcript)).toEqual(questionsRecordedIn(transcript));
    // The question this capture exists for.
    expect(replay(transcript)).toContain(ANOTHER_PATH.trim());
  });
});

describe('what an operator would type', () => {
  it.each([
    ['takes the offer at a question with a default', ASKED.role, RETURN],
    ['takes the offer at a port', ASKED.port, RETURN],
    ['adopts the provider that is already here', ASKED.adopt, RETURN],
    ['applies the plan it has just read', ASKED.apply, RETURN],
    ['declines a login no build can finish', ASKED.login, `n${RETURN}`],
    ['saves the plan, which is the artifact this checks', ASKED.save, `y${RETURN}`],
    ['leaves a provider this machine does not have alone', ASKED.install, `skip${RETURN}`],
    ['stops rather than going round again', ANOTHER_PATH, `n${RETURN}`],
  ])('%s', (_what, question, typed) => {
    expect(asAnOperatorWould(question)).toBe(typed);
  });

  it('declines a login whoever is asking', () => {
    // The rule is about the machine and not about the provider: nothing a build
    // container holds finishes anybody's browser flow, and a provider
    // registered later must not be the one that hangs this on it.
    expect(asAnOperatorWould('Log codex in now? [Y/n] ')).toBe(`n${RETURN}`);
  });

  it('types nothing at something that is not a question', () => {
    const transcript = fixture(BOOTSTRAP);
    const line = 'Looking at this machine.';
    expect(transcript).toContain(line);
    expect(asAnOperatorWould(line)).toBeUndefined();
  });
});

describe('the command line', () => {
  /** The shape the Dockerfile runs, with that machine's paths left out of it. */
  const REAL = ['--pty', '/prefix/node_modules/@agentplex/pty/dist/index.js', '--', 'bash'];

  it('reads the run to drive', () => {
    expect(parseInvocation([...REAL, '/install.sh', '--role=server'])).toEqual({
      ok: true,
      value: {
        ptyModule: '/prefix/node_modules/@agentplex/pty/dist/index.js',
        command: 'bash',
        args: ['/install.sh', '--role=server'],
      },
    });
  });

  it('takes a command with no arguments', () => {
    expect(parseInvocation(REAL)).toMatchObject({ ok: true, value: { args: [] } });
  });

  it.each([
    ['nothing at all', []],
    ['a module with no flag', ['/prefix/pty.js', '--', 'bash']],
    ['a flag with no module', ['--pty']],
    ['a module and no run', ['--pty', '/prefix/pty.js']],
    ['flags that never end', ['--pty', '/prefix/pty.js', 'bash']],
    ['an end and no command', ['--pty', '/prefix/pty.js', '--']],
  ])('refuses %s', (_what, argv) => {
    expect(parseInvocation(argv)).toMatchObject({ ok: false });
  });
});
