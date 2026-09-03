import { describe, expect, it } from 'vitest';
import { systemClock } from '../shared/clock.js';
import { randomIdGenerator } from '../shared/ids.js';
import { nodePtyFactory } from './node-pty-factory.js';
import { createPtySupervisor, type PtyRun } from './pty-supervisor.js';
import type { Launch } from './providers/provider-adapter.js';

/**
 * A real pty, a real child process, on whatever machine is running this.
 *
 * Every other test in this area drives an injected pty, which proves the
 * supervisor's judgement and nothing about the platform. Three claims cannot be
 * checked that way, and all three are load-bearing:
 *
 * - node-pty loads and can actually fork here. This is the test that fails when
 *   the `spawn-helper` executable bit is missing, and it fails with the real
 *   `posix_spawnp failed.` rather than at some later, stranger place.
 * - The child gets a *terminal*. Every coding agent asks `isTTY` and turns
 *   itself off on a pipe, so a supervisor that quietly handed out pipes would
 *   pass every unit test and drive nothing.
 * - The environment scrub survives the trip. A record asserted in a unit test
 *   is the supervisor's intent; `environ` read inside the child is the fact.
 *
 * `process.execPath` rather than a shell or a coreutil: it exists wherever this
 * suite runs, it can print exactly one fact, and it keeps the argv rule — no
 * shell, ever, and every element passed as an element.
 */

/** The child is a fork on a busy machine, not a function call. */
const CHILD_TIMEOUT_MS = 20_000;

const supervisor = createPtySupervisor({
  pty: nodePtyFactory,
  clock: systemClock,
  ids: randomIdGenerator,
  environment: {
    // The variable a nested Claude Code would inherit and go silent over.
    CLAUDECODE: '1',
    CLAUDE_CODE_SSE_PORT: '52321',
    AI_AGENT: 'claude',
    // Kept, and the control for the prefix rule: a substring is not a prefix.
    MY_CLAUDE_NOTE: 'kept',
    PATH: process.env.PATH ?? '',
  },
});

/** Runs one line of Node on a pty and returns everything it printed. */
function launchPrinting(source: string): Launch {
  return {
    ok: true,
    plan: {
      command: process.execPath,
      args: ['-e', source],
      cwd: process.cwd(),
      env: {},
      scrubEnvPrefixes: ['CLAUDE', 'AI_AGENT'],
    },
  };
}

async function output(run: PtyRun): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the child never exited')), CHILD_TIMEOUT_MS);
    const settle = (): void => {
      if (run.exit === null) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    // Polling rather than another subscription: `exit` is the supervisor's own
    // account of the run, and it is what the rest of the server will read.
    const poll = setInterval(settle, 10);
  });

  return run
    .scrollback()
    .map((chunk) => new TextDecoder().decode(chunk))
    .join('');
}

function start(source: string): PtyRun {
  const started = supervisor.launch(launchPrinting(source));
  if (!started.ok) throw new Error(`the launch was refused: ${started.problem}`);
  return started.run;
}

describe('nodePtyFactory', () => {
  it(
    'starts a real process and reports what it printed',
    { timeout: CHILD_TIMEOUT_MS },
    async () => {
      const run = start('process.stdout.write("hello from a pty\\n")');

      const printed = await output(run);

      expect(printed).toContain('hello from a pty');
      expect(run.exit).toEqual({ exitCode: 0, signal: null });
      expect(run.pid).toBeGreaterThan(0);
    },
  );

  it(
    'gives the child a terminal, which is the only way a TUI will run',
    async () => {
      const run = start('process.stdout.write(`isTTY=${process.stdout.isTTY === true}\\n`)');

      expect(await output(run)).toContain('isTTY=true');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'tells the child the terminal it is talking to',
    async () => {
      const run = start('process.stdout.write(`TERM=${process.env.TERM}\\n`)');

      expect(await output(run)).toContain('TERM=xterm-256color');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'scrubs the provider variables out of the environment the child really gets',
    async () => {
      // Read out of the child's own `process.env`, not out of the request the
      // supervisor built. This is the assertion the ticket exists for: with
      // CLAUDECODE inherited, Claude Code decides it is nested and stops saving
      // a transcript, which is the one file discovery has to read.
      const run = start(
        'const e = process.env;' +
          'process.stdout.write(`scrubbed=${["CLAUDECODE","CLAUDE_CODE_SSE_PORT","AI_AGENT"]' +
          '.every((n) => e[n] === undefined)} kept=${e.MY_CLAUDE_NOTE}\\n`)',
      );

      const printed = await output(run);

      expect(printed).toContain('scrubbed=true');
      expect(printed).toContain('kept=kept');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'carries what a user types into the child',
    async () => {
      // The child echoes what it read back with a marker. The marker matters:
      // the terminal echoes keystrokes on its own, so `typed` appears in the
      // output whether or not the child ever woke up, and only `read:` proves
      // the bytes reached the far side of the pty.
      //
      // It also matches on the text rather than on the carriage return that was
      // sent. A tty in its default line discipline translates CR to NL on the
      // way in (ICRNL), so the child is handed `typed\n` — which is exactly what
      // makes Enter work for a TUI, and exactly what a test asserting on `\r`
      // would sit and wait for forever.
      const run = start(
        'process.stdin.setEncoding("utf8");' +
          'process.stdin.on("data", (d) => { process.stdout.write(`read:${d.trim()}\\n`); process.exit(0); });',
      );

      run.write('typed\r');

      expect(await output(run)).toContain('read:typed');
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'kills a child that would otherwise outlive the server',
    async () => {
      const run = start('setInterval(() => {}, 1000)');

      run.kill();
      await output(run);

      expect(run.exit).not.toBeNull();
    },
    CHILD_TIMEOUT_MS,
  );
});
