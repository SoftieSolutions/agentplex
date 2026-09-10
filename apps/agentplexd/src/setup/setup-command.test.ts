import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeProcessProbe,
  createFakeStoreFiles,
  type FakeStoreFiles,
  printed,
  createFakeProviderFiles,
  providerFixturePath,
} from '@agentplex/providers/testing';
import {
  type ProcessRunner,
  createClaudeAdapter,
  createProviderRegistry,
} from '@agentplex/providers';
import { createFakePtyFactory } from '../server/fake-pty.js';
import { createPtySupervisor } from '../server/pty-supervisor.js';
import { createFakeHubDatabase, type FakeHubDatabase } from './fake-hub-database.js';
import { createFakeMachine, type FakeMachine } from './fake-machine.js';
import { createFakeSetupMachine } from './fake-setup-machine.js';
import { createFakeTerminal, type FakeTerminal } from './fake-terminal.js';
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
  return readFileSync(providerFixturePath(name), 'utf8');
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
  readonly terminal: FakeTerminal;
  readonly hubDatabase: FakeHubDatabase;
}

/** Every in-memory hub database a case opened, released when the case is over. */
const openedDatabases: FakeHubDatabase[] = [];

afterEach(async () => {
  for (const database of openedDatabases.splice(0)) await database.close();
});

async function run(
  argv: readonly string[],
  options: {
    readonly plan?: string;
    readonly machine?: FakeMachine;
    readonly files?: FakeStoreFiles;
    /** What the operator types, when the invocation is the interactive one. */
    readonly answers?: readonly string[];
    readonly hubDatabase?: FakeHubDatabase;
  } = {},
): Promise<Run> {
  const machine = options.machine ?? machineWithClaude();
  const hubDatabase = options.hubDatabase ?? createFakeHubDatabase();
  if (!openedDatabases.includes(hubDatabase)) openedDatabases.push(hubDatabase);
  const files =
    options.files ??
    createFakeStoreFiles({
      ...(options.plan === undefined ? {} : { files: { [PLAN_FILE]: options.plan } }),
    });
  const out: string[] = [];
  const errors: string[] = [];
  const binPaths: (readonly string[])[] = [];
  const terminal = createFakeTerminal({ answers: options.answers ?? [] });

  const dependencies: SetupCommandDependencies = {
    terminal,
    machine: createFakeSetupMachine({
      home: '/home/dev',
      pathDirectories: ['/opt/homebrew/bin'],
      directories: ['/home/dev/.claude'],
      executables: ['/opt/homebrew/bin/claude'],
    }),
    runnerFor: (binPath): ProcessRunner => {
      binPaths.push(binPath);
      return machine;
    },
    // Composed the way the entrypoint composes it, and reached only from the
    // wizard, and there only where a provider turns out to be logged out. A
    // `--plan` replay has nobody to hand a terminal to.
    supervisorFor: (binPath) =>
      createPtySupervisor({
        pty: createFakePtyFactory({ child: { exit: { exitCode: 0, signal: null } } }),
        clock: { now: () => 1_700_000_000_000 },
        ids: { newId: () => 'login-run' },
        environment: { PATH: binPath.join(':') },
      }),
    providersFor: () =>
      createProviderRegistry([
        createClaudeAdapter({
          files: createFakeProviderFiles(),
          probe: createFakeProcessProbe({}),
        }),
      ]),
    files,
    hubDatabase,
    ids: { newId: () => 'id-under-test' },
    tokens: { newToken: () => 'minted-on-the-machine' },
    clock: { now: () => 1_700_000_000_000 },
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  };

  const code = await runSetupCommand(argv, dependencies);
  return {
    code,
    out: out.join('\n'),
    errors: errors.join('\n'),
    files,
    binPaths,
    terminal,
    hubDatabase,
  };
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

  it('pairs nothing, even in --role=both, and even with a database in reach', async () => {
    // The bound the local-pairing exception is drawn at. This run is
    // `--role=both`, so a hub and a server end up on one host, and the command
    // is holding a hub database seam the wizard would have used. It writes no
    // row: a machine the plan named and nobody was present for is not a machine
    // a hub may decide to trust.
    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN });

    expect(replayed.hubDatabase.opened).toEqual([]);
    expect(replayed.code).toBe(0);
  });

  it('says the plan named the token, which is the unattended way to be pairable', async () => {
    // The sanctioned path for the fleet tier: somebody decided this secret
    // before the machine existed, so the instance is pairable the moment it
    // boots and the hub's end is made by whoever holds the hub.
    const replayed = await run(['--plan', PLAN_FILE], { plan: PLAN });

    expect(replayed.out).toContain('pairing: this machine is pairable with the token the plan');
    expect(replayed.out).not.toContain(PRE_MINTED);
  });

  it('says a token it minted has to be typed into a hub by somebody', async () => {
    // No token in the plan, so this machine minted its own. Pairing a hub with a
    // secret the run generated a moment earlier, with nobody present, is the hub
    // choosing which machines it trusts.
    const plan = JSON.parse(PLAN) as { server: { pairingToken: string | null } };
    plan.server.pairingToken = null;
    const replayed = await run(['--plan', PLAN_FILE], { plan: JSON.stringify(plan) });

    expect(replayed.hubDatabase.opened).toEqual([]);
    expect(replayed.out).toContain(`pairing: a token was minted into ${IDENTITY}`);
    expect(replayed.out).not.toContain('minted-on-the-machine');
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

/**
 * The other front end, from argv.
 *
 * What matters at this level is the dispatch and the exit code: which of the two
 * front ends an invocation means, and what an installer that ran `agentplexd
 * setup` learns from the number it gets back. The questions themselves are
 * `setup-wizard.test.ts`.
 */
describe('agentplexd setup', () => {
  it('asks when there is no plan to replay', async () => {
    const asked = await run([], { answers: ['', '', '', '', '', '', ''] });

    expect(asked.code).toBe(0);
    expect(asked.terminal.transcript).toContain('provider: claude 2.1.259 - adopted, logged in');
    expect(asked.errors).toBe('');
  });

  it('pre-seeds the first question with the role an installer was told', async () => {
    const asked = await run(['--role', 'server'], { answers: ['', '', '', '', ''] });

    expect(asked.code).toBe(0);
    expect(asked.terminal.questions).toContain('Role [server] ');
  });

  it('takes the role in either spelling of the flag', async () => {
    const asked = await run(['--role=hub'], { answers: ['', '', ''] });

    expect(asked.code).toBe(0);
    expect(asked.terminal.transcript).toContain('role: hub');
  });

  it('refuses a role that is not one', async () => {
    const asked = await run(['--role', 'gateway']);

    expect(asked.code).toBe(2);
    expect(asked.errors).toContain('--role takes one of: hub, server, both');
    expect(asked.terminal.questions).toEqual([]);
  });

  it('refuses a plan and a role together rather than picking one', async () => {
    // A plan states its own role and `--role` pre-seeds a question. An
    // invocation carrying both is somebody expecting one of them to win, and
    // which one they expected is not knowable from here.
    const asked = await run(['--plan', PLAN_FILE, '--role', 'hub'], { plan: PLAN });

    expect(asked.code).toBe(2);
    expect(asked.errors).toContain('--role pre-seeds the wizard');
    expect(asked.files.creates).toEqual([]);
  });

  it('says there is nobody to ask, and points at the front end that needs no one', async () => {
    // `agentplexd setup < /dev/null`, and a run under a service manager that
    // gave it no terminal. Nothing was asked and nothing was assumed.
    const asked = await run([]);

    expect(asked.code).toBe(2);
    expect(asked.errors).toContain('there is nobody to ask');
    expect(asked.errors).toContain('--plan');
    expect(asked.files.creates).toEqual([]);
  });

  it('exits zero when the operator declines the plan it built', async () => {
    // Nothing on the machine was changed and nothing failed. An installer that
    // read that as an error would be wrong about it.
    const declined = await run([], { answers: ['', '', '', '', '', 'n', 'n'] });

    expect(declined.code).toBe(0);
    expect(declined.files.creates).toEqual([]);
  });

  it('exits nonzero when the run it applied had problems', async () => {
    const failed = await run([], {
      answers: ['', '', '', '', '', '', ''],
      machine: createFakeMachine(),
    });

    expect(failed.code).toBe(1);
    expect(failed.terminal.transcript).toContain('provider: claude - not provisioned');
  });
});
