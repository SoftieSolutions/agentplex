import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createNodeSetupTerminal } from './node-setup-terminal.js';

/**
 * The real readline, against real streams.
 *
 * It is an integration test because the whole of what this module implements is
 * one claim about a runtime, and a claim about a runtime is not settled until it
 * has been run: `question` does not settle when the input ends underneath it. A
 * test with a fake readline in it would assert the belief rather than the
 * behaviour, and the belief is what is wrong.
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
