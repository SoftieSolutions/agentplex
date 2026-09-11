import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createFakeProcessProbe,
  createFakeStoreFiles,
  type FakeStoreFiles,
  printed,
  refused,
  createFakeProviderFiles,
  providerFixturePath,
} from '@agentplex/providers/testing';
import { createClaudeAdapter, createProviderRegistry } from '@agentplex/providers';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { createFakeMachine, type FakeMachine } from './fake-machine.js';
import { createFakeSetupMachine, type FakeSetupMachine } from './fake-setup-machine.js';
import { createFakeTerminal, type FakeTerminal } from './fake-terminal.js';
import { parseSetupPlan } from './setup-plan.js';
import { runSetupWizard, type WizardOutcome } from './setup-wizard.js';

/**
 * The interactive front end, end to end: answers in, a plan and a provisioned
 * machine out.
 *
 * The adoption rule is what most of this is about, because it is what the ticket
 * is about. An operator's existing `claude` is the one they authenticated, so
 * setup adopts it and records the directory it was found in; installing a second
 * copy into an owned prefix and putting it first on PATH would shadow a working,
 * logged-in binary with a fresh one that is not, and the failure would present as
 * an authentication bug with nothing pointing at the cause.
 *
 * Every answer here is a line somebody typed, and an empty one is the offer being
 * taken. A test that presses return through the whole wizard is therefore an
 * assertion about what setup discovered, not about what a test wrote down.
 */

function fixture(name: string): string {
  return readFileSync(providerFixturePath(name), 'utf8');
}

const HOME = '/home/dev';
const HOMEBREW = '/opt/homebrew/bin';
const SHIMS = '/home/dev/.local/share/mise/shims';
const PREFIX = `${HOME}/.agentplex`;
const IDENTITY = `${PREFIX}/server.json`;
const STORE = `${HOME}/.claude`;
const PLAN_FILE = `${PREFIX}/setup-plan.json`;
const SETTINGS = `${PREFIX}/agentplex.env`;

const INSTALL_ARGV =
  `npm install --global --prefix ${PREFIX} --json --no-ignore-scripts ` +
  '@anthropic-ai/claude-code@latest';

/** Everything the operator presses return through, on a machine with claude on it. */
const STRAIGHT_THROUGH = ['', '', '', '', '', '', '', ''];

/**
 * The same, on a machine whose `claude` is logged out: one more return, for the
 * offer to log it in. Pressing return through the whole wizard is meant to end
 * with the providers logged in, so that offer's own answer is yes.
 */
const LOG_IN_TOO = ['', '', '', '', '', '', '', '', ''];

/** A machine with `claude` on it that nobody has signed into. */
function loggedOutMachine(): FakeMachine {
  return createFakeMachine({
    programs: {
      'claude --version': printed(fixture('claude-version.txt')),
      // Captured with the exit code it really has: 2.1.259 exits 1 while
      // printing the answer.
      'claude auth status --json': {
        kind: 'exited',
        exitCode: 1,
        stdout: fixture('claude-auth-status-logged-out.json'),
        stderr: '',
      },
    },
  });
}

function loggedIn(): Readonly<Record<string, ReturnType<typeof printed>>> {
  return {
    'claude --version': printed(fixture('claude-version.txt')),
    'claude auth status --json': printed(fixture('claude-auth-status-logged-in.json')),
  };
}

interface Run {
  readonly outcome: WizardOutcome;
  readonly terminal: FakeTerminal;
  readonly runner: FakeMachine;
  readonly machine: FakeSetupMachine;
  readonly files: FakeStoreFiles;
  readonly binPaths: readonly (readonly string[])[];
  /** The directories every pty the wizard opened would have resolved through. */
  readonly ptyBinPaths: readonly (readonly string[])[];
  readonly ptys: FakePtyFactory;
}

/** The settings file as setup left it, line by line, or nothing if it never wrote one. */
function settings(machine: FakeSetupMachine, path = SETTINGS): readonly string[] {
  return machine.contents.get(path)?.split('\n') ?? [];
}

async function run(
  answers: readonly string[],
  options: {
    readonly machine?: FakeSetupMachine;
    readonly runner?: FakeMachine;
    readonly files?: FakeStoreFiles;
    readonly role?: 'hub' | 'server' | 'both';
    readonly terminal?: FakeTerminal;
  } = {},
): Promise<Run> {
  const terminal = options.terminal ?? createFakeTerminal({ answers });
  const machine =
    options.machine ??
    createFakeSetupMachine({
      home: HOME,
      pathDirectories: ['/usr/bin', HOMEBREW],
      directories: [STORE],
      executables: [`${HOMEBREW}/claude`],
    });
  const runner = options.runner ?? createFakeMachine({ programs: loggedIn() });
  const files = options.files ?? createFakeStoreFiles();
  const binPaths: (readonly string[])[] = [];
  const ptyBinPaths: (readonly string[])[] = [];
  // A login that prints something and ends, which is what one the operator
  // completed looks like from outside the pty.
  const ptys = createFakePtyFactory({
    child: {
      prints: 'Log in at https://example.invalid/\r\n',
      exit: { exitCode: 0, signal: null },
    },
  });

  const outcome = await runSetupWizard(
    { role: options.role ?? null },
    {
      terminal,
      machine,
      runnerFor: (binPath) => {
        binPaths.push(binPath);
        return runner;
      },
      supervisorFor: (binPath) => {
        ptyBinPaths.push(binPath);
        return createPtySupervisor({
          pty: ptys,
          clock: { now: () => 1_700_000_000_000 },
          ids: { newId: () => 'login-run' },
          environment: { PATH: binPath.join(':') },
        });
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
      clock: { now: () => 1_700_000_000_000 },
    },
  );

  return {
    outcome,
    terminal,
    runner,
    machine,
    files,
    binPaths,
    ptyBinPaths,
    ptys,
  };
}

/** The plan the wizard saved, read back through the parser that reads a file. */
function savedPlan(files: FakeStoreFiles, path = PLAN_FILE) {
  const contents = files.contents.get(path);
  expect(contents).toBeDefined();
  const parsed = parseSetupPlan(contents ?? '');
  if (!parsed.ok) throw new Error(`the wizard saved a plan it cannot read: ${parsed.problems}`);
  return parsed.plan;
}

describe('the setup wizard', () => {
  it('adopts the claude the operator already has, and installs nothing', async () => {
    const wizard = await run(STRAIGHT_THROUGH);

    expect(wizard.outcome).toEqual({ kind: 'applied', problems: [] });
    // The whole rule, in one assertion: there was a working binary, so nothing
    // was installed over it.
    expect(wizard.runner.installs).toEqual([]);
    expect(wizard.terminal.transcript).toContain('provider: claude 2.1.259 - adopted, logged in');
  });

  it('records the directory the adopted binary is in, ahead of the prefix it owns', async () => {
    // This is the value that ends the silent ENOENT: the service resolves
    // `claude` in the directory setup probed rather than in whatever PATH
    // systemd handed it, and the operator's own copy resolves first.
    const wizard = await run([...STRAIGHT_THROUGH, '']);

    expect(wizard.terminal.transcript).toContain(`resolve programs in: ${HOMEBREW}, ${PREFIX}/bin`);
    expect(wizard.binPaths).toContainEqual([HOMEBREW, `${PREFIX}/bin`]);
  });

  it('identifies the store it found and mints an identity for the server', async () => {
    const wizard = await run(STRAIGHT_THROUGH);

    expect(wizard.files.contents.get(`${STORE}/agentplex-store.json`)).toContain('id-under-test');
    expect(wizard.files.contents.get(IDENTITY)).toContain('minted-on-the-machine');
    // A machine that has never run setup has no prefix, and `createFile` makes
    // no parents: without this the identity file is an ENOENT in a report.
    expect(wizard.machine.made).toContain(PREFIX);
  });

  it('installs into the prefix it owns when there is nothing to adopt', async () => {
    const runner = createFakeMachine({
      installers: [
        {
          argv: INSTALL_ARGV,
          first: printed(fixture('npm-install-added.json')),
          again: printed(fixture('npm-install-up-to-date.json')),
          programs: loggedIn(),
        },
      ],
    });
    const wizard = await run(STRAIGHT_THROUGH, {
      machine: createFakeSetupMachine({ home: HOME, pathDirectories: ['/usr/bin', HOMEBREW] }),
      runner,
    });

    expect(wizard.outcome).toEqual({ kind: 'applied', problems: [] });
    expect(wizard.runner.installs).toEqual([INSTALL_ARGV]);
    expect(wizard.terminal.transcript).toContain('claude: not on this machine');
    // Nothing of the operator's is recorded, because there was nothing of
    // theirs: the prefix is the only place the provider can resolve from.
    expect(wizard.terminal.transcript).toContain(`resolve programs in: ${PREFIX}/bin`);
  });

  it('will not adopt a copy that cannot say what it is, and says why in its own words', async () => {
    // The version-manager shim that needs its own environment, found while a
    // person is present rather than at the first spawn of the first session.
    // Adoption is not offered: the recorded directory becomes the service's PATH,
    // where there is no login shell and no shim environment, and recording it
    // would also shadow the copy setup is about to install.
    const runner = createFakeMachine({
      programs: {
        'claude --version': refused(1, fixture('claude-version-no-native-binary.txt')),
      },
      installers: [
        {
          argv: INSTALL_ARGV,
          first: printed(fixture('npm-install-added.json')),
          again: printed(fixture('npm-install-up-to-date.json')),
          programs: loggedIn(),
        },
      ],
    });
    const wizard = await run(STRAIGHT_THROUGH, {
      machine: createFakeSetupMachine({
        home: HOME,
        pathDirectories: [SHIMS],
        directories: [STORE],
        executables: [`${SHIMS}/claude`],
      }),
      runner,
    });

    expect(wizard.terminal.transcript).toContain('claude native binary not installed');
    expect(wizard.terminal.transcript).toContain('A version manager shim');
    // The offer, and the one choice that is not offered.
    expect(wizard.terminal.lines).toContain(
      '  install - let agentplex install its own copy into the prefix it owns',
    );
    expect(wizard.terminal.lines.some((line) => line.startsWith('  adopt -'))).toBe(false);
    // And the substance: the shim's directory is not recorded, so the copy that
    // was installed is the copy that resolves.
    expect(wizard.terminal.transcript).toContain(`resolve programs in: ${PREFIX}/bin`);
    expect(wizard.runner.installs).toEqual([INSTALL_ARGV]);
  });

  it('leaves a provider out of the plan entirely when told to skip it', async () => {
    const wizard = await run(['', '', '', '', 'skip', '', '', 'y', '']);

    expect(wizard.runner.installs).toEqual([]);
    expect(wizard.terminal.transcript).toContain('providers: none');
    expect(savedPlan(wizard.files).role).toBe('both');
    const plan = savedPlan(wizard.files);
    expect('server' in plan && plan.server.providers).toEqual([]);
  });

  it('starts on the role an installer already knows, and still shows the others', async () => {
    // `--role` pre-seeds the question rather than replacing it: `curl | bash -s
    // -- --role=server` is an intention stated, not a chance to see what setup
    // found waived.
    const wizard = await run(['', '', '', '', '', ''], { role: 'server' });

    expect(wizard.terminal.questions).toContain('Role [server] ');
    expect(wizard.terminal.lines).toContain(
      '  hub - the database, the web app, and the machine that dials the servers',
    );
    expect(wizard.terminal.transcript).toContain('role: server');
    // A server plan has no hub half, so it was never asked about a hub port.
    expect(wizard.terminal.questions.some((question) => question.startsWith('Hub port'))).toBe(
      false,
    );
  });

  it('asks a hub nothing about stores, providers or prefixes', async () => {
    const wizard = await run(['hub', '', '', ''], {});

    expect(wizard.outcome).toEqual({ kind: 'applied', problems: [] });
    expect(wizard.terminal.questions.some((question) => question.startsWith('Stores'))).toBe(false);
    expect(wizard.runner.installs).toEqual([]);
    expect(wizard.files.creates).toEqual([]);
  });

  it('takes the stores it was given over the ones it found, and refuses a relative path', async () => {
    // The whole answer is asked for again rather than the good half being kept:
    // a relative path in a plan names a different directory on every boot, and
    // half of what somebody meant, provisioned quietly, is the worse outcome.
    const wizard = await run(['', '', '', 'work, /srv/other', '/srv/other', '', '', '', '']);

    expect(wizard.terminal.transcript).toContain('A store path has to be absolute: work');
    expect(wizard.terminal.transcript).toContain('stores: /srv/other');
  });

  it('takes no stores at all as an answer', async () => {
    // Legal in the configuration too: a server whose volume is not mounted yet
    // reports no stores rather than refusing to start.
    const wizard = await run(['', '', '', 'none', '', '', '', 'y', '']);

    const plan = savedPlan(wizard.files);
    expect('server' in plan && plan.server.storePaths).toEqual([]);
  });

  it('saves the plan it applied, and it is a plan the other front end reads', async () => {
    const wizard = await run([...STRAIGHT_THROUGH.slice(0, 7), 'y', '']);

    expect(wizard.terminal.transcript).toContain(`Saved ${PLAN_FILE}`);
    const plan = savedPlan(wizard.files);
    expect(plan.role).toBe('both');
    expect('server' in plan && plan.server.binPath).toEqual([HOMEBREW]);
    expect('server' in plan && plan.server.providers).toEqual([
      // Never a pin of the version that happens to be installed today: replaying
      // that in a month would turn the operator's upgrade into a downgrade.
      { provider: 'claude', version: null },
    ]);
  });

  it('puts no secret in the plan it offers to write', async () => {
    // A plan is a file that ends up in user-data, in an image, and in whatever
    // bucket somebody copied it to. The token this machine pairs with is minted
    // into the identity file, where the server has always kept it.
    const wizard = await run([...STRAIGHT_THROUGH.slice(0, 7), 'y', '']);

    const contents = wizard.files.contents.get(PLAN_FILE) ?? '';
    expect(contents).not.toContain('minted-on-the-machine');
    expect(contents).toContain('"pairingToken": null');
    expect(wizard.terminal.transcript).not.toContain('minted-on-the-machine');
  });

  it('never writes over a plan that is already there', async () => {
    const files = createFakeStoreFiles({ files: { [PLAN_FILE]: '{"someone else": true}' } });
    const wizard = await run([...STRAIGHT_THROUGH.slice(0, 7), 'y', '', 'y', '/tmp/plan.json'], {
      files,
    });

    expect(wizard.files.contents.get(PLAN_FILE)).toBe('{"someone else": true}');
    expect(wizard.terminal.transcript).toContain(`There is already a file at ${PLAN_FILE}`);
    expect(wizard.files.contents.get('/tmp/plan.json')).toContain('"role": "both"');
  });

  it('changes nothing when the operator says no to the plan, and still offers to save it', async () => {
    const wizard = await run(['', '', '', '', '', 'n', 'y', '']);

    expect(wizard.outcome).toEqual({ kind: 'abandoned' });
    expect(wizard.runner.installs).toEqual([]);
    // The store file and the identity file are what provisioning writes; the
    // only thing on disk is the artifact the operator asked for.
    expect(wizard.files.creates).toEqual([PLAN_FILE]);
    expect(wizard.terminal.transcript).toContain('Nothing on this machine was changed.');
  });

  it('stops without assuming anything when there is nobody to answer', async () => {
    const wizard = await run([]);

    expect(wizard.outcome).toEqual({ kind: 'no-input' });
    expect(wizard.files.creates).toEqual([]);
    expect(wizard.runner.installs).toEqual([]);
  });

  it('stops rather than provisioning a machine it cannot describe', async () => {
    // No `$HOME`: there is nowhere to own a prefix. The plan the answers make is
    // put through the same parser a plan file goes through, which is what turns
    // this into a named refusal instead of a `/.agentplex`.
    const wizard = await run(STRAIGHT_THROUGH, {
      machine: createFakeSetupMachine({ home: '', pathDirectories: [HOMEBREW] }),
    });

    expect(wizard.outcome.kind).toBe('unusable');
    expect(wizard.terminal.transcript).toContain('must be an absolute path');
    expect(wizard.files.creates).toEqual([]);
  });

  it('drives the login of a provider that is not logged in, on the pty seam', async () => {
    // The step this ticket is about. A provider that is installed and logged out
    // is a session that will not start, and the only thing that fixes it is the
    // provider's own browser flow — which needs a terminal, which setup is.
    const wizard = await run(LOG_IN_TOO, { runner: loggedOutMachine() });

    expect(wizard.outcome).toEqual({ kind: 'applied', problems: [] });
    // The argv is the adapter's own login launch and not a string written in the
    // wizard, which is what keeps it right when a provider renames a subcommand.
    expect(wizard.ptys.opened.map((request) => [request.command, ...request.args])).toEqual([
      ['claude', 'auth', 'login'],
    ]);
    // In the store the sessions will run against, not in whichever home the
    // setup process happens to have.
    expect(wizard.ptys.opened[0]?.env['CLAUDE_CONFIG_DIR']).toBe(STORE);
    // And what the login printed reached the operator.
    expect(wizard.terminal.attachedOutput.join('')).toContain('https://example.invalid/');
  });

  it('resolves the login through the directories the plan recorded', async () => {
    // The whole of the adoption rule, applied to the one operation that changes a
    // provider's state: the copy that gets logged in has to be the copy the
    // server will run, or the credentials belong to a binary nothing starts.
    const wizard = await run(LOG_IN_TOO, { runner: loggedOutMachine() });

    expect(wizard.ptyBinPaths).toEqual([[HOMEBREW, `${PREFIX}/bin`]]);
  });

  it('asks the provider again afterwards rather than believing the login exit code', async () => {
    // The login exits 0 here and the machine still says logged out, which is
    // exactly what a flow cancelled at the browser looks like. The probe is what
    // the preflight, `doctor` and the first session read, so the probe is what
    // the wizard reports.
    const wizard = await run(LOG_IN_TOO, { runner: loggedOutMachine() });

    expect(wizard.terminal.transcript).toContain(
      'The login ran and it still reports itself logged out.',
    );
    expect(wizard.terminal.transcript).toContain('Run: claude auth login');
  });

  it('names the login to run for a provider the operator will log in later', async () => {
    // Declining is a legitimate answer, and the sentence it gets is the one that
    // was already true: installed, not logged in, and here is what to type.
    const wizard = await run(['', '', '', '', '', '', 'n', '', ''], { runner: loggedOutMachine() });

    expect(wizard.ptys.opened).toEqual([]);
    expect(wizard.terminal.transcript).toContain(
      'claude is installed and not logged in. Run: claude auth login',
    );
  });

  it('says what is left rather than hanging a login on an input that is not a terminal', async () => {
    // `printf ... | agentplex setup`: there is a wizard, because its answers
    // arrived on stdin, and there is nobody to answer an OAuth prompt.
    const terminal = createFakeTerminal({
      answers: LOG_IN_TOO,
      notATerminal: 'this input is not a terminal',
    });
    const wizard = await run([], { runner: loggedOutMachine(), terminal });

    expect(wizard.terminal.transcript).toContain(
      'Setup could not run the login here: this input is not a terminal',
    );
    expect(wizard.terminal.transcript).toContain('Run: claude auth login');
  });

  it('offers no login for a provider whose state could not be read', async () => {
    // `authState` is null when the probe would not answer — a wrapper in front
    // of `claude`, a release that stopped printing what the parser reads. Sending
    // an operator through a login for that would be inventing a diagnosis, and
    // the apply path has already reported it in the program's own words.
    const runner = createFakeMachine({
      programs: {
        'claude --version': printed(fixture('claude-version.txt')),
        'claude auth status --json': printed('Corporate SSO required\n'),
      },
    });
    const wizard = await run(STRAIGHT_THROUGH, { runner });

    expect(wizard.ptys.opened).toEqual([]);
    expect(wizard.terminal.transcript).toContain('did not report its authentication state');
  });

  it('records the server on this machine for the hub on it, and nobody types a token', async () => {
    // The exception, exercised: one operator, one host, one interactive run, and
    // a server the hub reaches over the loopback. Setup writes the two settings
    // that name it; the hub pairs it at boot from the token in the file.
    const wizard = await run(STRAIGHT_THROUGH);

    expect(settings(wizard.machine)).toEqual(
      expect.arrayContaining([
        `AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=${IDENTITY}`,
        'AGENTPLEX_LOCAL_SERVER_PORT=8081',
      ]),
    );
    // The token is the one the identity file holds, which is the one the server
    // will present and the hub will read. Nothing minted a second, and nothing
    // put it in the settings.
    expect(wizard.files.contents.get(IDENTITY)).toContain('minted-on-the-machine');
    expect(wizard.machine.contents.get(SETTINGS)).not.toContain('minted-on-the-machine');
    expect(wizard.terminal.questions.some((question) => question.includes('token'))).toBe(false);
  });

  it('fills in the lines the installer left for it rather than adding a second copy', async () => {
    const machine = createFakeSetupMachine({
      home: HOME,
      pathDirectories: ['/usr/bin', HOMEBREW],
      directories: [STORE],
      executables: [`${HOMEBREW}/claude`],
      files: {
        [SETTINGS]: [
          'AGENTPLEX_ROLE=both',
          '#AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=/var/lib/agentplex/server.json',
          '#AGENTPLEX_LOCAL_SERVER_PORT=8081',
          '',
        ].join('\n'),
      },
    });

    const wizard = await run(STRAIGHT_THROUGH, { machine });

    expect(settings(wizard.machine)).toEqual([
      'AGENTPLEX_ROLE=both',
      `AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=${IDENTITY}`,
      'AGENTPLEX_LOCAL_SERVER_PORT=8081',
      '',
    ]);
  });

  it('names the settings the hub has to be started from, and never the token', async () => {
    // The one way this arrangement fails silently: a hub started without these
    // settings reads, from the hub, as a machine that is not there.
    const wizard = await run(STRAIGHT_THROUGH);

    expect(wizard.terminal.transcript).toContain('dialling ws://127.0.0.1:8081');
    expect(wizard.terminal.transcript).toContain(`--local-server-identity-file ${IDENTITY}`);
    expect(wizard.terminal.transcript).toContain(
      `Recorded the server on this machine in ${SETTINGS}`,
    );
    expect(wizard.terminal.transcript).not.toContain('minted-on-the-machine');
    // The directory the operator named, made before anything tried to write a
    // file in it.
    expect(wizard.machine.made).toContain(PREFIX);
  });

  it('leaves one line per setting when setup is run twice on the same machine', async () => {
    const machine = createFakeSetupMachine({
      home: HOME,
      pathDirectories: ['/usr/bin', HOMEBREW],
      directories: [STORE],
      executables: [`${HOMEBREW}/claude`],
    });
    const files = createFakeStoreFiles();

    await run(STRAIGHT_THROUGH, { machine, files });
    await run(STRAIGHT_THROUGH, { machine, files });

    const lines = settings(machine);
    expect(lines.filter((line) => line.startsWith('AGENTPLEX_LOCAL_SERVER_PORT='))).toHaveLength(1);
    expect(
      lines.filter((line) => line.startsWith('AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=')),
    ).toHaveLength(1);
  });

  it('writes no settings when the operator does not name a file', async () => {
    // Declining is a legitimate answer, and what it gets is the sentence that
    // was true before this step existed: the token is in that file, and typing
    // it into a hub is how this machine gets paired.
    const wizard = await run(['', '', '', '', '', '', 'none', '']);

    expect(wizard.machine.writes).toEqual([]);
    expect(wizard.terminal.transcript).toContain(`paired: the pairing token is in ${IDENTITY}`);
  });

  it('records nothing in --role=server, and does not ask about settings', async () => {
    // The bound that matters most. A `--role=server` machine is one a hub
    // elsewhere has to be told about by a person, which is the rule the
    // loopback case is the exception to.
    const wizard = await run(['', '', '', '', '', ''], { role: 'server' });

    expect(wizard.machine.writes).toEqual([]);
    expect(
      wizard.terminal.questions.some((question) => question.startsWith('Hub settings file')),
    ).toBe(false);
  });

  it('records nothing in --role=hub: there is no server on this machine', async () => {
    const wizard = await run(['hub', '', '', ''], {});

    expect(wizard.machine.writes).toEqual([]);
    expect(wizard.terminal.transcript).toContain(
      'The hub needs a database file and a client token to start.',
    );
  });

  it('says what it could not record rather than failing the run', async () => {
    const wizard = await run(STRAIGHT_THROUGH, {
      machine: createFakeSetupMachine({
        home: HOME,
        pathDirectories: ['/usr/bin', HOMEBREW],
        directories: [STORE],
        executables: [`${HOMEBREW}/claude`],
        unwritable: [SETTINGS],
      }),
    });

    // A machine that is provisioned and unrecorded is a machine somebody can
    // finish by hand; a run that exited over it would have thrown away the
    // providers it installed.
    expect(wizard.outcome).toEqual({ kind: 'applied', problems: [] });
    expect(wizard.terminal.transcript).toContain('This machine was not recorded');
  });

  it('asks again rather than taking a port it could not read', async () => {
    const wizard = await run(['', 'eight thousand', '9090', '', '', '', '', '', '']);

    expect(wizard.terminal.transcript).toContain(
      'eight thousand is not a port between 1 and 65535',
    );
    expect(wizard.terminal.transcript).toContain('hub: port 9090');
  });
});
