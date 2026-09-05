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
});
