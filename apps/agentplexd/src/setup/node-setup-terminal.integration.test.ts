import process from 'node:process';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { nodePtyFactory } from '../server/node-pty-factory.js';
import type { Launch } from '../server/providers/provider-adapter.js';
import { createPtySupervisor, type PtyRun } from '../server/pty-supervisor.js';
import { systemClock, randomIdGenerator } from '@agentplex/node-shared';
import { createNodeSetupTerminal } from './node-setup-terminal.js';

/**
 * The real readline, against real streams, and the real terminal in front of a
 * real child on a real pty.
 *
 * It is an integration test because everything this module implements is a claim
 * about a runtime, and a claim about a runtime is not settled until it has been
 * run. `question` does not settle when the input ends underneath it; `pause()`
 * does not stop a readline reading; a child on a pipe is a child that will not
 * draw a prompt. A test with a fake readline and a fake pty in it would assert
 * the beliefs rather than the behaviour, and the beliefs are what are wrong.
 */

function collected(): { readonly output: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  return {
    output: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

/** Fails the test rather than hanging it: the failure this module exists for. */
function withinASecond<T>(work: Promise<T>): Promise<T | 'never settled'> {
  return Promise.race([
    work,
    new Promise<'never settled'>((resolve) => setTimeout(() => resolve('never settled'), 1000)),
  ]);
}

describe('the real setup terminal', () => {
  it('answers every question from a piped input, in order, however early it arrived', async () => {
    // Both lines are there before the first question is asked, which is what
    // `printf 'a\nb\n' | agentplexd setup` looks like. A terminal that only
    // listens while a question is outstanding answers the first one and then
    // reports that the input ended, having silently dropped the rest.
    const { output, text } = collected();
    const terminal = createNodeSetupTerminal({
      input: Readable.from(['/srv/work\n', 'yes\n']),
      output,
    });

    expect(await withinASecond(terminal.ask('which store [/home/dev/.claude] '))).toEqual({
      kind: 'typed',
      text: '/srv/work',
    });
    terminal.write('recorded');
    expect(await withinASecond(terminal.ask('apply it? [Y/n] '))).toEqual({
      kind: 'typed',
      text: 'yes',
    });

    expect(text()).toContain('which store [/home/dev/.claude] ');
    expect(text()).toContain('recorded\n');
  });

  it('answers that the input ended when the input ends under a pending question', async () => {
    // `agentplexd setup < /dev/null`, and the `^D` at any prompt. Node's own
    // question promise never settles here; the race against `close` is the
    // whole of this module.
    const { output } = collected();
    const terminal = createNodeSetupTerminal({ input: Readable.from([]), output });

    expect(await withinASecond(terminal.ask('which store '))).toEqual({ kind: 'ended' });
  });

  it('keeps answering that the input ended once it has', async () => {
    // A wizard asks more than one question, and readline throws rather than
    // waits after it has closed. Every question from here on has the same
    // answer, so the wizard's loop ends where it should.
    const { output } = collected();
    const input = new PassThrough();
    const terminal = createNodeSetupTerminal({ input, output });

    input.write('both\n');
    expect(await withinASecond(terminal.ask('role '))).toEqual({ kind: 'typed', text: 'both' });

    input.end();
    expect(await withinASecond(terminal.ask('hub port '))).toEqual({ kind: 'ended' });
    expect(await withinASecond(terminal.ask('server port '))).toEqual({ kind: 'ended' });
  });

  it('reads nothing from an input nothing has asked about', async () => {
    // `agentplexd setup --plan <file>` builds a terminal and never asks it
    // anything. `createInterface` starts reading the moment it is built, so a
    // terminal built at construction would resume stdin — and an unattended
    // replay, which has nobody at it at all, would then never exit.
    const { output } = collected();
    const input = new PassThrough();

    const terminal = createNodeSetupTerminal({ input, output });
    terminal.write('replayed a plan');

    // The listener is the whole of it: attaching one is what starts a read, and
    // a stream nothing has read is a stream holding nothing open.
    expect(input.listenerCount('data')).toBe(0);
  });

  it('gives the input back when it is closed', async () => {
    // The bug this exists for: an input that has been read keeps the event loop
    // alive until it ends, and a terminal never ends. Measured at the origin on
    // Node 24.20, neither `close()` on the interface nor `pause()` on the input
    // is enough on its own — the handle stays referenced until it is unrefed.
    const { output } = collected();
    const input = new PassThrough();
    let released = 0;
    Object.assign(input, { unref: () => (released += 1) });

    const terminal = createNodeSetupTerminal({ input, output });
    input.write('both\n');
    expect(await withinASecond(terminal.ask('role '))).toEqual({ kind: 'typed', text: 'both' });
    expect(input.listenerCount('data')).toBe(1);

    terminal.close();

    expect(input.listenerCount('data')).toBe(0);
    expect(input.isPaused()).toBe(true);
    expect(released).toBe(1);
    // And nothing is left to be asked, rather than a question nobody will ever
    // answer.
    expect(await withinASecond(terminal.ask('hub port '))).toEqual({ kind: 'ended' });
  });

  it('can be closed when it was never asked anything, and closed twice', async () => {
    const { output } = collected();
    const terminal = createNodeSetupTerminal({ input: new PassThrough(), output });

    terminal.close();
    terminal.close();

    expect(await withinASecond(terminal.ask('role '))).toEqual({ kind: 'ended' });
  });
});

/**
 * A pair of streams that say they are a terminal.
 *
 * `isTTY` and `setRawMode` are what `process.stdin` brings and a pipe does not,
 * and the module reads them to decide whether there is a terminal to hand over
 * at all. A stream that answers those questions is a real implementation of the
 * seam, not a mock of it — what it cannot do is make raw mode mean anything,
 * since there is no line discipline under a `PassThrough`. So the raw-mode calls
 * are recorded and the *relay* is what is asserted: the bytes each side got.
 */
function terminalStreams(): {
  readonly input: PassThrough & { isTTY: boolean; setRawMode: (raw: boolean) => void };
  readonly output: Writable & { isTTY: boolean; columns: number; rows: number };
  readonly text: () => string;
  readonly rawModes: readonly boolean[];
} {
  const rawModes: boolean[] = [];
  const chunks: string[] = [];

  return {
    rawModes,
    text: () => chunks.join(''),
    input: Object.assign(new PassThrough(), {
      isTTY: true,
      // A method that reads its receiver, on purpose. `tty.ReadStream`'s own
      // `setRawMode` reaches for `this._handle`, so a seam that pulled the
      // function off the stream and called it bare would pass every test with an
      // arrow function here and throw the moment it met a real terminal.
      setRawMode(this: PassThrough, raw: boolean): void {
        if (!(this instanceof PassThrough)) throw new TypeError('setRawMode lost its receiver');
        rawModes.push(raw);
      },
    }),
    output: Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(String(chunk));
          done();
        },
      }),
      { isTTY: true, columns: 100, rows: 30 },
    ),
  };
}

/** The child is a fork on a busy machine, not a function call. */
const CHILD_TIMEOUT_MS = 20_000;

const supervisor = createPtySupervisor({
  pty: nodePtyFactory,
  clock: systemClock,
  ids: randomIdGenerator,
  environment: { PATH: process.env['PATH'] ?? '' },
});

/**
 * One line of Node on a pty, standing in for a provider's login TUI.
 *
 * `process.execPath` rather than `claude`: this suite has to run on a machine
 * with no provider installed, and what is under test is the terminal in front of
 * a pty rather than anything about Claude Code. It keeps the argv rule — no
 * shell, ever, and every element passed as an element.
 */
function start(source: string): PtyRun {
  const launch: Launch = {
    ok: true,
    plan: {
      command: process.execPath,
      args: ['-e', source],
      cwd: process.cwd(),
      env: {},
      scrubEnvPrefixes: [],
    },
  };
  const started = supervisor.launch(launch);
  if (!started.ok) throw new Error(`the launch was refused: ${started.problem}`);
  return started.run;
}

/** A login that prints a prompt, takes one answer, and ends. */
const ASKS_FOR_A_CODE =
  'process.stdout.write("Paste the code: ");' +
  'process.stdin.setEncoding("utf8");' +
  'process.stdin.on("data", (d) => { process.stdout.write(`read:${d.trim()}\\n`); process.exit(0); });';

describe('the real setup terminal, handed to a real child on a pty', () => {
  it(
    'carries the program output to the operator and their keystrokes back to it',
    async () => {
      // The whole of what hosting an OAuth exchange means: a URL the operator
      // can read, and a code they paste reaching the far side of the pty.
      //
      // `read:` and not just the text: a terminal echoes keystrokes on its own,
      // so `a-code` would appear in the output whether or not the child ever
      // woke up. And `\r` on the way in, which the tty's line discipline turns
      // into the `\n` that makes Enter work for a TUI.
      const streams = terminalStreams();
      const terminal = createNodeSetupTerminal(streams);

      // Asked first, because that is the arrangement the handover has to
      // survive: the wizard puts "Log claude in now?" and attaches on the
      // answer, so there is a live readline interface holding the input when
      // the login arrives.
      const asking = terminal.ask('Log claude in now? [Y/n] ');
      streams.input.write('\r');
      await withinASecond(asking);

      const attaching = terminal.attach(start(ASKS_FOR_A_CODE));
      streams.input.write('a-code\r');

      expect(await attaching).toEqual({ kind: 'ended' });
      expect(streams.text()).toContain('Paste the code: ');
      expect(streams.text()).toContain('read:a-code');
      // The whole handover, recorded: readline takes the terminal at the first
      // question, gives it up when the attach closes it, the attach makes it raw
      // for the child, and puts it back when the child ends. Raw in the middle
      // is what stops the line discipline eating the `^C` and the arrow keys a
      // login's TUI is waiting for.
      expect(streams.rawModes).toEqual([true, false, true, false]);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'asks its own questions again once the program has ended',
    async () => {
      // The gotcha this module's shape exists for. `pause()` does not stop a
      // readline reading, so an attach has to give the interface up and take a
      // fresh one back; get it wrong in the other direction and the wizard's
      // line reader is gone for the rest of the run and every remaining question
      // reports that the operator went away.
      const streams = terminalStreams();
      const terminal = createNodeSetupTerminal(streams);

      const attaching = terminal.attach(start(ASKS_FOR_A_CODE));
      streams.input.write('a-code\r');
      await attaching;

      streams.input.write('both\n');
      expect(await withinASecond(terminal.ask('role [both] '))).toEqual({
        kind: 'typed',
        text: 'both',
      });
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'does not answer a question with what the operator typed at the program',
    async () => {
      // The other half of the same gotcha, and the one that is silent: a
      // readline still listening during the attach parses the login's
      // keystrokes into lines and hands the next question one of them. An
      // operator would then find the wizard had answered a question they never
      // saw, with a fragment of an OAuth code.
      const streams = terminalStreams();
      const terminal = createNodeSetupTerminal(streams);

      const attaching = terminal.attach(start(ASKS_FOR_A_CODE));
      streams.input.write('a-code\r');
      await attaching;

      // Nothing typed since. The question waits rather than taking `a-code`.
      expect(await withinASecond(terminal.ask('role [both] '))).toBe('never settled');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'reports that there is no terminal to hand over rather than starting a flow nobody can finish',
    async () => {
      // `printf '...' | agentplexd setup`. There is a wizard, because its
      // answers arrived on stdin, and there is nobody to answer an OAuth prompt:
      // a login driven from here would sit on a code that never comes.
      const { output } = collected();
      const terminal = createNodeSetupTerminal({ input: new PassThrough(), output });
      const run = start('setInterval(() => {}, 1000)');

      const attached = await terminal.attach(run);
      run.kill();

      expect(attached).toEqual({
        kind: 'unavailable',
        problem:
          'this input is not a terminal, and an interactive program needs one: ' +
          'run setup in a terminal to drive it from here',
      });
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'gives the terminal back when the operator goes away under a program that is still running',
    async () => {
      // An ssh session that dropped mid-login. The child is still there, which is
      // the difference this outcome carries: the caller kills it rather than
      // leaving a `claude auth login` holding a pty nobody is at.
      const streams = terminalStreams();
      const terminal = createNodeSetupTerminal(streams);
      const run = start('setInterval(() => {}, 1000)');

      const attaching = terminal.attach(run);
      streams.input.end();

      expect(await attaching).toEqual({ kind: 'abandoned' });
      expect(run.exit).toBeNull();
      run.kill();
    },
    CHILD_TIMEOUT_MS,
  );
});
