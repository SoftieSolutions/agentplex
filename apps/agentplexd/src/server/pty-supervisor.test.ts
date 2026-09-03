import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Launch, LaunchPlan } from './providers/provider-adapter.js';
import { createFakePtyFactory } from './fake-pty.js';
import { createPtySupervisor, scrubEnvironment } from './pty-supervisor.js';

const PLAN: LaunchPlan = {
  command: 'claude',
  args: ['--resume', 'a-session'],
  cwd: '/Users/dev/Code/agentplex',
  env: {},
  scrubEnvPrefixes: ['CLAUDE', 'AI_AGENT'],
};

const launch = (plan: Partial<LaunchPlan> = {}): Launch => ({
  ok: true,
  plan: { ...PLAN, ...plan },
});

function fixedClock(now = 1_700_000_000_000): Clock {
  return { now: () => now };
}

function countingIds(): IdGenerator {
  let next = 0;
  return { newId: () => `run-${(next += 1)}` };
}

function supervisorOver(
  factory = createFakePtyFactory(),
  environment: Readonly<Record<string, string | undefined>> = {},
  scrollbackBytes?: number,
) {
  const supervisor = createPtySupervisor({
    pty: factory,
    clock: fixedClock(),
    ids: countingIds(),
    environment,
    // Omitted rather than passed as undefined: the workspace is on
    // `exactOptionalPropertyTypes`, so "not given" and "given as undefined"
    // are different arguments and only the first one takes the default.
    ...(scrollbackBytes === undefined ? {} : { scrollbackBytes }),
  });
  return { supervisor, factory };
}

const decode = (chunks: readonly Uint8Array[]): string =>
  chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');

describe('scrubEnvironment', () => {
  it('removes every variable a plan named by prefix', () => {
    // The one that silently breaks things. A Claude Code started from inside
    // another Claude Code inherits CLAUDE_CODE_SSE_PORT and CLAUDECODE, decides
    // it is a nested run, and stops writing a transcript. Nothing errors: the
    // session runs and agentplex simply never sees it again, because a
    // transcript is the only thing discovery reads.
    const scrubbed = scrubEnvironment(
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_SSE_PORT: '52321',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        AI_AGENT: 'claude',
        AI_AGENT_MODEL: 'opus',
      },
      ['CLAUDE', 'AI_AGENT'],
      {},
    );

    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });

  it('matches on a prefix and not on a substring', () => {
    const scrubbed = scrubEnvironment(
      { MY_CLAUDE_TOKEN: 'keep', CLAUDE_TOKEN: 'drop' },
      ['CLAUDE'],
      {},
    );

    expect(scrubbed).toEqual({ MY_CLAUDE_TOKEN: 'keep' });
  });

  it('drops variables with no value rather than passing an empty string', () => {
    // `process.env` types every entry as possibly undefined and a pty needs a
    // record of strings. Turning absence into "" would define the variable,
    // and plenty of tools branch on defined rather than on truthy.
    const scrubbed = scrubEnvironment({ PATH: '/usr/bin', EMPTY: undefined }, [], {});

    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });

  it('applies the plan variables after the scrub, so an adapter can set one back', () => {
    // Order is the decision. The scrub is about what is *inherited*; a variable
    // the adapter states deliberately is not an inheritance, and an adapter
    // that needs to pass CLAUDE_CONFIG_DIR to point a child at a store must be
    // able to without the scrub eating it a line later.
    const scrubbed = scrubEnvironment({ CLAUDE_CONFIG_DIR: '/home/dev/.claude' }, ['CLAUDE'], {
      CLAUDE_CONFIG_DIR: '/volumes/store',
    });

    expect(scrubbed).toEqual({ CLAUDE_CONFIG_DIR: '/volumes/store' });
  });

  it('scrubs nothing when a provider names no prefixes', () => {
    const scrubbed = scrubEnvironment({ CLAUDE_TOKEN: 'kept' }, [], {});

    expect(scrubbed).toEqual({ CLAUDE_TOKEN: 'kept' });
  });
});

describe('createPtySupervisor.launch', () => {
  it('opens a pty from the plan, with the scrubbed environment', () => {
    const { supervisor, factory } = supervisorOver(createFakePtyFactory(), {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
    });

    const started = supervisor.launch(launch());

    expect(started.ok).toBe(true);
    expect(factory.opened).toEqual([
      {
        command: 'claude',
        args: ['--resume', 'a-session'],
        cwd: '/Users/dev/Code/agentplex',
        env: { PATH: '/usr/bin' },
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      },
    ]);
  });

  it('passes a refusal through untouched instead of opening anything', () => {
    // The adapter said no for a reason a person has to read. A supervisor that
    // turned it into an exception, or into its own wording, would lose it.
    const { supervisor, factory } = supervisorOver();

    const started = supervisor.launch({ ok: false, problem: 'no working directory' });

    expect(started).toEqual({ ok: false, problem: 'no working directory' });
    expect(factory.opened).toEqual([]);
  });

  it('turns a pty that will not open into a refusal, naming what failed', () => {
    // `posix_spawnp failed.` is what a missing executable bit on node-pty's
    // spawn-helper actually raises. It must reach the user as an answer about
    // this session rather than an unhandled throw taking the server with it.
    const { supervisor } = supervisorOver(
      createFakePtyFactory({ failsToOpen: 'posix_spawnp failed.' }),
    );

    const started = supervisor.launch(launch());

    expect(started.ok).toBe(false);
    expect(!started.ok && started.problem).toContain('posix_spawnp failed.');
    expect(!started.ok && started.problem).toContain('claude');
  });

  it('dates and identifies the run from the injected seams', () => {
    const { supervisor } = supervisorOver(createFakePtyFactory({ pids: [4242] }));

    const started = supervisor.launch(launch());

    expect(started.ok && started.run.runId).toBe('run-1');
    expect(started.ok && started.run.pid).toBe(4242);
    expect(started.ok && started.run.startedAt).toBe(1_700_000_000_000);
  });

  it('takes the terminal size from the caller when it has one', () => {
    const { supervisor, factory } = supervisorOver();

    supervisor.launch(launch(), { cols: 200, rows: 50 });

    expect(factory.opened[0]?.cols).toBe(200);
    expect(factory.opened[0]?.rows).toBe(50);
  });
});

describe('createPtySupervisor runs', () => {
  it('buffers output and replays it to a client that attached late', () => {
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());

    factory.last?.emit('before anyone was looking');

    expect(started.ok && decode(started.run.scrollback())).toBe('before anyone was looking');
  });

  it('forwards output to subscribers and stops when they unsubscribe', () => {
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    const seen: string[] = [];
    const unsubscribe = started.run.subscribe((chunk) =>
      seen.push(new TextDecoder().decode(chunk)),
    );

    factory.last?.emit('one');
    unsubscribe();
    factory.last?.emit('two');

    expect(seen).toEqual(['one']);
  });

  it('keeps buffering after a subscriber has gone', () => {
    // The buffer is the session's, not the viewer's. Closing the last tab must
    // not cost the output that arrives while nobody is watching.
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    started.run.subscribe(() => {})();
    factory.last?.emit('printed to nobody');

    expect(decode(started.run.scrollback())).toBe('printed to nobody');
  });

  it('drops whole chunks once the scrollback is full', () => {
    const { supervisor, factory } = supervisorOver(createFakePtyFactory(), {}, 8);
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    factory.last?.emit('aaaa');
    factory.last?.emit('bbbb');
    factory.last?.emit('cccc');

    expect(decode(started.run.scrollback())).toBe('bbbbcccc');
  });

  it('carries keystrokes and resizes to the pty', () => {
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    started.run.write('yes\r');
    started.run.resize(120, 40);

    expect(factory.last?.written).toEqual(['yes\r']);
    expect(factory.last?.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('records the exit and keeps the output that led to it', () => {
    // A session that just died is the session somebody most wants to read.
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    factory.last?.emit('the last thing it said');
    factory.last?.close({ exitCode: 1, signal: null });

    expect(started.run.exit).toEqual({ exitCode: 1, signal: null });
    expect(decode(started.run.scrollback())).toBe('the last thing it said');
  });

  it('will not write to a run that has exited', () => {
    const { supervisor, factory } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    factory.last?.close({ exitCode: 0, signal: null });
    started.run.write('anyone there?');
    started.run.kill();

    expect(factory.last?.written).toEqual([]);
    expect(factory.last?.kills).toBe(0);
  });

  it('lists live runs and forgets one on request', () => {
    const { supervisor } = supervisorOver();
    const started = supervisor.launch(launch());
    if (!started.ok) throw new Error('the launch should have started');

    expect(supervisor.runs.map((run) => run.runId)).toEqual(['run-1']);
    expect(supervisor.run('run-1')).toBe(started.run);

    supervisor.forget('run-1');

    expect(supervisor.runs).toEqual([]);
    expect(supervisor.run('run-1')).toBeUndefined();
  });

  it('kills every run it is holding when the server stops', () => {
    const { supervisor, factory } = supervisorOver();
    supervisor.launch(launch());
    supervisor.launch(launch());

    supervisor.stopAll();

    expect(factory.ptys.map((pty) => pty.kills)).toEqual([1, 1]);
  });
});
