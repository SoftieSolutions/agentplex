import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../server/fake-process-probe.js';
import { createFakeStoreFiles, type FakeStoreFiles } from '../server/fake-store-files.js';
import { printed } from '../server/operations/fake-process-runner.js';
import type { ProcessRunner } from '../server/operations/process-runner.js';
import { createClaudeAdapter } from '../server/providers/claude-adapter.js';
import { createFakeProviderFiles } from '../server/providers/fake-provider-files.js';
import { createProviderRegistry } from '../server/providers/provider-registry.js';
import { createFakeMachine, type FakeMachine } from './fake-machine.js';
import { runSetupCommand, type SetupCommandDependencies } from './setup-command.js';
import { SETUP_PLAN_VERSION } from './setup-plan.js';

/**
 * The unattended front end, end to end: a command line, a file on disk, a report
 * and an exit code.
 *
 * The exit code is the half that matters most here. Nothing reads the report on
 * an EC2 instance whose plan came in user-data; what acts on the outcome is
 * cloud-init, and it acts on a number.
 */

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', 'server', 'providers', 'fixtures', name),
    'utf8',
  );
}

const PLAN_FILE = '/etc/agentplex/plan.json';
const PREFIX = '/var/lib/agentplex';
const IDENTITY = '/var/lib/agentplex/server.json';
const STORE = '/srv/work';
const PRE_MINTED = 'x'.repeat(43);

const PLAN = JSON.stringify({
  version: SETUP_PLAN_VERSION,
  role: 'both',
  hub: { port: 8080 },
  server: {
    port: 8081,
    storePaths: [STORE],
    binPath: ['/opt/homebrew/bin'],
    identityPath: IDENTITY,
    installPrefix: PREFIX,
    pairingToken: PRE_MINTED,
    providers: [{ provider: 'claude', version: null }],
  },
});

/** A machine with an authenticated `claude` on it, printing what it really prints. */
function machineWithClaude(): FakeMachine {
  return createFakeMachine({
    programs: {
      'claude --version': printed(fixture('claude-version.txt')),
      'claude auth status --json': printed(fixture('claude-auth-status-logged-in.json')),
    },
  });
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly errors: string;
  readonly files: FakeStoreFiles;
  readonly binPaths: readonly (readonly string[])[];
}

async function run(
  argv: readonly string[],
  options: {
    readonly plan?: string;
    readonly machine?: FakeMachine;
    readonly files?: FakeStoreFiles;
  } = {},
): Promise<Run> {
  const machine = options.machine ?? machineWithClaude();
  const files =
    options.files ??
    createFakeStoreFiles({
      ...(options.plan === undefined ? {} : { files: { [PLAN_FILE]: options.plan } }),
    });
  const out: string[] = [];
  const errors: string[] = [];
  const binPaths: (readonly string[])[] = [];

  const dependencies: SetupCommandDependencies = {
    runnerFor: (binPath): ProcessRunner => {
      binPaths.push(binPath);
      return machine;
    },
    providersFor: () =>
      createProviderRegistry([
        createClaudeAdapter({
          files: createFakeProviderFiles(),
          probe: createFakeProcessProbe({}),
        }),
      ]),
    files,
    ids: { newId: () => 'id-under-test' },
    tokens: { newToken: () => 'minted-on-the-machine' },
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  };

  const code = await runSetupCommand(argv, dependencies);
  return { code, out: out.join('\n'), errors: errors.join('\n'), files, binPaths };
}

describe('agentplexd setup --plan', () => {
  it('replays the plan it was pointed at and says what the machine now is', async () => {
    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN });

    expect(replayed.code).toBe(0);
    expect(replayed.errors).toBe('');
    for (const fact of [
      'role: both',
      'hub: port 8080',
      'server: port 8081',
      `bin path: /opt/homebrew/bin, ${join(PREFIX, 'bin')}`,
      IDENTITY,
      STORE,
      'provider: claude 2.1.259 - adopted, logged in',
    ]) {
      expect(replayed.out).toContain(fact);
    }
  });

  it('takes the plan file in either spelling of the flag', async () => {
    const replayed = await run([`--plan=${PLAN_FILE}`], { plan: PLAN });

    expect(replayed.code).toBe(0);
  });

  it('resolves programs in the directories the plan named', async () => {
    // The wiring the whole binPath design turns on, asserted where it is decided:
    // the runner setup probes with searches the plan's own directories, and the
    // prefix agentplex installs into is behind them.
    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN });

    expect(replayed.binPaths).toEqual([['/opt/homebrew/bin', join(PREFIX, 'bin')]]);
  });

  it('never prints the pairing token, and writes it where the server reads it', async () => {
    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN });

    expect(replayed.out).not.toContain(PRE_MINTED);
    expect(replayed.errors).not.toContain(PRE_MINTED);
    // Named by its location instead, which is the one thing an operator needs.
    expect(replayed.out).toContain('the pairing token is in that file');
    expect(replayed.files.contents.get(IDENTITY)).toContain(PRE_MINTED);
  });

  it('refuses an invocation with no plan, and touches nothing', async () => {
    // There is no interactive fallback in this build. Starting a wizard that
    // does not exist, or provisioning some default machine, are both worse than
    // saying which flag is missing.
    const replayed = await run([]);

    expect(replayed.code).toBe(2);
    expect(replayed.errors).toContain('--plan');
    expect(replayed.errors).toContain('Usage: agentplexd setup --plan <file>');
    expect(replayed.files.creates).toEqual([]);
  });

  it('refuses an argument it does not know', async () => {
    // Ignoring `--pln` would replay nothing and report success, which is the
    // failure `readFlags` refuses for the daemon's own flags.
    const replayed = await run(['--pln', PLAN_FILE], { plan: PLAN });

    expect(replayed.code).toBe(2);
    expect(replayed.errors).toContain('--pln');
  });

  it('refuses a flag with nothing after it', async () => {
    const replayed = await run(['--plan'], { plan: PLAN });

    expect(replayed.code).toBe(2);
    expect(replayed.errors).toContain('--plan needs a value');
  });

  it('names the plan file it could not find', async () => {
    const replayed = await run(['--plan', '/etc/agentplex/absent.json'], { plan: PLAN });

    expect(replayed.code).toBe(2);
    expect(replayed.errors).toContain('/etc/agentplex/absent.json');
  });

  it('reports every problem in a plan that does not parse, and starts nothing', async () => {
    const machine = machineWithClaude();
    const replayed = await run(['--plan', PLAN_FILE], {
      machine,
      plan: JSON.stringify({
        version: SETUP_PLAN_VERSION,
        role: 'server',
        server: {
          port: 0,
          storePaths: ['work'],
          binPath: [],
          identityPath: IDENTITY,
          installPrefix: PREFIX,
          providers: [],
        },
      }),
    });

    // Two bad fields, two lines, one boot. A plan that fails one field at a time
    // is a machine that has to be rebooted once per typo.
    expect(replayed.code).toBe(2);
    expect(replayed.errors).toContain('port');
    expect(replayed.errors).toContain('storePaths');
    expect(machine.requests).toEqual([]);
  });

  it('exits nonzero when the run had problems, and says what they were', async () => {
    // A machine with no claude and no npm to install one: the install cannot
    // run, and an unattended caller has to be able to tell.
    const replayed = await run(['--plan', PLAN_FILE], {
      plan: PLAN,
      machine: createFakeMachine(),
    });

    expect(replayed.code).toBe(1);
    expect(replayed.errors).toContain('claude');
    expect(replayed.out).toContain('provider: claude - not provisioned');
  });

  it('reports a provider that is installed and logged out without failing the run', async () => {
    // The honest end of an unattended boot. There is no way to log in without a
    // person — it is a browser flow through a pty — so a nonzero exit here would
    // fail every EC2 instance that provisioned correctly.
    const machine = createFakeMachine({
      programs: {
        'claude --version': printed(fixture('claude-version.txt')),
        'claude auth status --json': {
          kind: 'exited',
          exitCode: 1,
          stdout: fixture('claude-auth-status-logged-out.json'),
          stderr: '',
        },
      },
    });

    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN, machine });

    expect(replayed.code).toBe(0);
    expect(replayed.out).toContain('not logged in');
  });

  it('leaves the machine as it was when the same plan is replayed', async () => {
    const machine = machineWithClaude();
    const files = createFakeStoreFiles({ files: { [PLAN_FILE]: PLAN } });

    const first = await run(['--plan', PLAN_FILE], { machine, files });
    const afterFirst = new Map(files.contents);
    const second = await run(['--plan', PLAN_FILE], { machine, files });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(new Map(files.contents)).toEqual(afterFirst);
    expect(machine.installs).toEqual([]);
  });
});
