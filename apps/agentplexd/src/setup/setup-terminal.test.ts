import { describe, expect, it } from 'vitest';
import { createFakeTerminal } from './fake-terminal.js';
import { askChoice, askFor, askText, askYesNo } from './setup-terminal.js';

/**
 * The vocabulary the wizard asks its questions in.
 *
 * What is asserted here is the three rules that make an interactive front end
 * safe to put in front of a machine: the offer is visible in the prompt and
 * return takes it, an answer nobody could parse is asked again rather than
 * quietly dropped, and an input that has ended stops the questions instead of
 * defaulting through them.
 */

describe('askText', () => {
  it('takes the offer when the operator presses return', async () => {
    const terminal = createFakeTerminal({ answers: [''] });

    const asked = await askText(terminal, 'which store', '/home/dev/.claude');

    expect(asked).toEqual({ kind: 'answered', value: '/home/dev/.claude' });
    // The offer is in the prompt: what return takes is never something the
    // operator has to have read elsewhere.
    expect(terminal.questions).toEqual(['which store [/home/dev/.claude] ']);
  });

  it('takes what was typed over what was offered', async () => {
    const terminal = createFakeTerminal({ answers: ['  /srv/work  '] });

    const asked = await askText(terminal, 'which store', '/home/dev/.claude');

    expect(asked).toEqual({ kind: 'answered', value: '/srv/work' });
  });

  it('reports an input that ended rather than answering for the operator', async () => {
    const terminal = createFakeTerminal();

    expect(await askText(terminal, 'which store', '/home/dev/.claude')).toEqual({ kind: 'ended' });
  });
});

describe('askFor', () => {
  it('asks again, saying why, when the answer does not parse', async () => {
    const terminal = createFakeTerminal({ answers: ['eight thousand', '9090'] });

    const asked = await askFor(terminal, 'port ', 8080, (text) =>
      /^\d+$/.test(text)
        ? { ok: true, value: Number(text) }
        : { ok: false, problem: `${text} is not a port number` },
    );

    expect(asked).toEqual({ kind: 'answered', value: 9090 });
    expect(terminal.lines).toContain('eight thousand is not a port number');
    expect(terminal.questions).toHaveLength(2);
  });

  it('never puts an empty answer to the parser', async () => {
    // The empty line is the offer being accepted, and the offer is the wizard's
    // own value. A parser given a chance to refuse it is a wizard that can
    // refuse what it just proposed.
    const terminal = createFakeTerminal({ answers: [''] });

    const asked = await askFor(terminal, 'port ', 8080, () => ({
      ok: false,
      problem: 'nothing is acceptable',
    }));

    expect(asked).toEqual({ kind: 'answered', value: 8080 });
    expect(terminal.lines).toEqual([]);
  });

  it('stops asking when the input ends mid-question', async () => {
    const terminal = createFakeTerminal({ answers: ['nonsense'] });

    const asked = await askFor(terminal, 'port ', 8080, () => ({
      ok: false,
      problem: 'no',
    }));

    expect(asked).toEqual({ kind: 'ended' });
  });
});

describe('askYesNo', () => {
  it('reads either spelling of either answer', async () => {
    const terminal = createFakeTerminal({ answers: ['Yes', 'n', 'YES', 'No'] });

    for (const expected of [true, false, true, false]) {
      expect(await askYesNo(terminal, 'apply it?', true)).toEqual({
        kind: 'answered',
        value: expected,
      });
    }
  });

  it('shows which way return goes', async () => {
    const terminal = createFakeTerminal({ answers: ['', ''] });

    expect(await askYesNo(terminal, 'apply it?', true)).toEqual({ kind: 'answered', value: true });
    expect(await askYesNo(terminal, 'save it?', false)).toEqual({ kind: 'answered', value: false });
    expect(terminal.questions).toEqual(['apply it? [Y/n] ', 'save it? [y/N] ']);
  });

  it('asks again when the answer is neither', async () => {
    const terminal = createFakeTerminal({ answers: ['maybe', 'y'] });

    expect(await askYesNo(terminal, 'apply it?', false)).toEqual({ kind: 'answered', value: true });
    expect(terminal.lines).toContain('answer yes or no, not maybe');
  });
});

describe('askChoice', () => {
  const CHOICES = [
    { value: 'hub' as const, name: 'hub', summary: 'the database and the web app' },
    { value: 'server' as const, name: 'server', summary: 'runs sessions on this machine' },
    { value: 'both' as const, name: 'both', summary: 'one process, one machine' },
  ];

  it('prints what each choice means before asking', async () => {
    // The questions this asks are ones an operator is entitled to decide with
    // the facts in front of them rather than in another document.
    const terminal = createFakeTerminal({ answers: ['server'] });

    const asked = await askChoice(terminal, 'role', CHOICES, CHOICES[2]!);

    expect(asked).toEqual({ kind: 'answered', value: 'server' });
    expect(terminal.lines).toEqual([
      '  hub - the database and the web app',
      '  server - runs sessions on this machine',
      '  both - one process, one machine',
    ]);
    expect(terminal.questions).toEqual(['role [both] ']);
  });

  it('refuses a word that is not one of them, and names the ones that are', async () => {
    const terminal = createFakeTerminal({ answers: ['gateway', 'HUB'] });

    const asked = await askChoice(terminal, 'role', CHOICES, CHOICES[2]!);

    expect(asked).toEqual({ kind: 'answered', value: 'hub' });
    expect(terminal.lines).toContain('pick one of: hub, server, both');
  });
});
