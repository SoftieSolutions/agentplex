import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFakeProcessProbe,
  createFakeStoreFiles,
  printed,
  createFakeProviderAdapter,
  createFakeProviderFiles,
  providerFixturePath,
} from '@agentplex/providers/testing';
import {
  type ProcessOutcome,
  createClaudeAdapter,
  CLAUDE_PACKAGE,
  createProviderRegistry,
  STORE_FILE_NAME,
} from '@agentplex/providers';
import { applySetupPlan, type SetupPlanDependencies } from './apply-setup-plan.js';
import { createFakeMachine, type FakeMachine } from './fake-machine.js';
import { parseSetupPlan, SETUP_PLAN_VERSION, type SetupPlan } from './setup-plan.js';

/**
 * Replaying a plan, against a machine that changes when something is installed
 * on it.
 *
 * Every byte a program prints here is captured output of the program that
 * printed it, borrowed from the adapter's own fixtures: what setup does with an
 * install depends entirely on what npm actually says about one, and the case a
 * reconciling setup hits most — a package that is already at the version asked
 * for — is a `change` and not an `add`, which is a detail only the capture has.
 */

function fixture(name: string): string {
  return readFileSync(providerFixturePath(name), 'utf8');
}

const CLAUDE_VERSION = '2.1.259';
const NPM_ADDED = fixture('npm-install-added.json');
const NPM_UP_TO_DATE = fixture('npm-install-up-to-date.json');
const NPM_NO_SUCH_VERSION = fixture('npm-install-no-such-version.json');
const CLAUDE_VERSION_OUTPUT = fixture('claude-version.txt');
const AUTH_LOGGED_IN = fixture('claude-auth-status-logged-in.json');
const AUTH_LOGGED_OUT = fixture('claude-auth-status-logged-out.json');

const PREFIX = '/var/lib/agentplex';
const IDENTITY = '/var/lib/agentplex/server.json';
const STORE = '/srv/work';
const PRE_MINTED = 'x'.repeat(43);

const CLAUDE_PROBE = 'claude --version';
const CLAUDE_AUTH = 'claude auth status --json';
const npmInstall = (version: string): string =>
  `npm install --global --prefix ${PREFIX} --json --no-ignore-scripts ${CLAUDE_PACKAGE}@${version}`;

/** Claude Code reports a logout by printing one and exiting 1. Captured, not guessed. */
const LOGGED_OUT: ProcessOutcome = {
  kind: 'exited',
  exitCode: 1,
  stdout: AUTH_LOGGED_OUT,
  stderr: '',
};
const LOGGED_IN: ProcessOutcome = printed(AUTH_LOGGED_IN);

/** A machine with `claude` already on it, which is what setup adopts. */
function machineWithClaude(auth: ProcessOutcome = LOGGED_IN): FakeMachine {
  return createFakeMachine({
    programs: { [CLAUDE_PROBE]: printed(CLAUDE_VERSION_OUTPUT), [CLAUDE_AUTH]: auth },
  });
}

/** A bare machine, and the npm that puts Claude Code on it. */
function bareMachine(auth: ProcessOutcome = LOGGED_OUT): FakeMachine {
  return createFakeMachine({
    installers: [
      {
        argv: npmInstall('latest'),
        first: printed(NPM_ADDED),
        again: printed(NPM_UP_TO_DATE),
        programs: { [CLAUDE_PROBE]: printed(CLAUDE_VERSION_OUTPUT), [CLAUDE_AUTH]: auth },
      },
    ],
  });
}

function claudeOnly() {
  return createProviderRegistry([
    createClaudeAdapter({ files: createFakeProviderFiles(), probe: createFakeProcessProbe({}) }),
  ]);
}

function createIds() {
  let next = 0;
  return { newId: () => `id-${(next += 1)}` };
}

function dependencies(
  machine: FakeMachine,
  overrides: Partial<SetupPlanDependencies> = {},
): SetupPlanDependencies {
  return {
    runner: machine,
    providers: claudeOnly(),
    files: createFakeStoreFiles(),
    ids: createIds(),
    tokens: { newToken: () => 'minted-on-the-machine' },
    ...overrides,
  };
}

function serverPlan(overrides: Readonly<Record<string, unknown>> = {}): SetupPlan {
  const parsed = parseSetupPlan(
    JSON.stringify({
      version: SETUP_PLAN_VERSION,
      role: 'server',
      server: {
        port: 8081,
        storePaths: [STORE],
        binPath: [],
        identityPath: IDENTITY,
        installPrefix: PREFIX,
        providers: [{ provider: 'claude', version: null }],
        ...overrides,
      },
    }),
  );
  if (!parsed.ok)
    throw new Error(`the test's own plan does not parse: ${parsed.problems.join('; ')}`);
  return parsed.plan;
}

describe('replaying a setup plan', () => {
  it('adopts a provider that is already on the machine, and installs nothing', async () => {
    // Adoption is not a nicety. The operator's existing `claude` is the one they
    // have authenticated, and installing a second copy in front of it would
    // shadow a working, logged-in binary with a fresh one that is not.
    const machine = machineWithClaude();

    const outcome = await applySetupPlan(serverPlan(), dependencies(machine));

    expect(outcome.server?.providers).toEqual([
      {
        provider: 'claude',
        action: 'adopted',
        version: CLAUDE_VERSION,
        authState: 'authenticated',
        problems: [],
      },
    ]);
    expect(machine.installs).toEqual([]);
  });

  it('installs a provider that is not there, and reports what landed', async () => {
    const machine = bareMachine();

    const outcome = await applySetupPlan(serverPlan(), dependencies(machine));

    expect(machine.installs).toEqual([npmInstall('latest')]);
    expect(outcome.server?.providers).toEqual([
      {
        provider: 'claude',
        action: 'installed',
        version: CLAUDE_VERSION,
        // Reported and not fixed. There is no way to log in unattended — it is
        // a browser flow through a pty — so the honest end of an EC2 boot is
        // "installed, not logged in", which the spec calls a worse outcome than
        // logged in and a far better one than silence.
        authState: 'unauthenticated',
        problems: [],
      },
    ]);
    expect(outcome.problems).toEqual([]);
  });

  it('leaves the machine in the same state when the same plan is replayed', async () => {
    // The property the whole ticket turns on. Not "the second run is a no-op":
    // the second run probes, decides the machine already matches the plan, and
    // does nothing about it.
    const machine = bareMachine();
    const files = createFakeStoreFiles();
    const dependency = dependencies(machine, { files });
    const plan = serverPlan();

    const first = await applySetupPlan(plan, dependency);
    const afterFirst = new Map(files.contents);
    const second = await applySetupPlan(plan, dependency);

    expect(machine.installs).toHaveLength(1);
    expect(new Map(files.contents)).toEqual(afterFirst);
    expect(second.server?.providers).toEqual([
      { ...first.server?.providers[0], action: 'adopted' },
    ]);
    // The one difference between the two runs, and it is a statement about the
    // run rather than about the machine: the first minted, the second read.
    expect(first.server?.identity.minted).toBe(true);
    expect(second.server?.identity.minted).toBe(false);
    expect(second.server?.stores).toEqual(
      first.server?.stores.map((store) => ({ ...store, minted: false })),
    );
    expect(second.problems).toEqual([]);
  });

  it('mints the store and the server identity the plan names', async () => {
    const files = createFakeStoreFiles();

    const outcome = await applySetupPlan(
      serverPlan(),
      dependencies(machineWithClaude(), { files }),
    );

    expect(outcome.server?.identity).toEqual({
      path: IDENTITY,
      serverId: 'id-1',
      minted: true,
      problem: null,
    });
    expect(outcome.server?.stores).toEqual([
      { ok: true, store: { storeId: 'id-2', path: STORE }, minted: true },
    ]);
    expect([...files.contents.keys()]).toEqual([IDENTITY, join(STORE, STORE_FILE_NAME)]);
  });

  it('writes the plan’s pre-minted token, and never hands it back', async () => {
    // The EC2 tier: the token was decided before the machine existed, so the
    // instance is pairable the moment it boots. It goes into the identity file
    // the server already reads and nowhere else — not into the outcome, which is
    // printed to a terminal and, on a cloud instance, into a boot log.
    const files = createFakeStoreFiles();

    const outcome = await applySetupPlan(
      serverPlan({ pairingToken: PRE_MINTED }),
      dependencies(machineWithClaude(), { files }),
    );

    expect(JSON.parse(files.contents.get(IDENTITY) ?? '')).toEqual({
      serverId: 'id-1',
      token: PRE_MINTED,
    });
    expect(JSON.stringify(outcome)).not.toContain(PRE_MINTED);
  });

  it('never writes a plan’s token over an identity the machine already has', async () => {
    // A plan replayed onto a machine that was already set up with a different
    // token. Overwriting would present the machine to its hub as a server nobody
    // paired; the pairing the operator completed would stop working, and nothing
    // would say why. Refusing costs a message somebody can act on.
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'already-here', token: 'y'.repeat(43) }) },
    });

    const outcome = await applySetupPlan(
      serverPlan({ pairingToken: PRE_MINTED }),
      dependencies(machineWithClaude(), { files }),
    );

    expect(outcome.server?.identity).toMatchObject({ serverId: 'already-here', minted: false });
    expect(outcome.server?.identity.problem).toContain(IDENTITY);
    expect(outcome.problems).toHaveLength(1);
    expect(JSON.parse(files.contents.get(IDENTITY) ?? '')).toMatchObject({
      token: 'y'.repeat(43),
    });
  });

  it('installs a pinned version over an adopted one that is not it', async () => {
    // A pin is what makes replaying an artifact in a month produce the machine
    // it described, so an adopted binary that is not the pinned version does not
    // satisfy the plan. The made-up provider, because the captured Claude Code
    // fixtures are all one version and a second version of them would be a
    // fixture somebody wrote.
    const machine = createFakeMachine({
      programs: { 'claude version': printed('1.0.0'), 'claude whoami': printed('') },
      installers: [
        {
          argv: `fakepkg add --into ${PREFIX} claude`,
          first: printed('9.9.9'),
          again: printed('9.9.9'),
          programs: { 'claude version': printed('9.9.9') },
        },
      ],
    });

    const outcome = await applySetupPlan(
      serverPlan({ providers: [{ provider: 'claude', version: '9.9.9' }] }),
      dependencies(machine, { providers: createProviderRegistry([createFakeProviderAdapter()]) }),
    );

    expect(machine.installs).toHaveLength(1);
    expect(outcome.server?.providers).toEqual([
      {
        provider: 'claude',
        action: 'installed',
        version: '9.9.9',
        authState: 'authenticated',
        problems: [],
      },
    ]);
  });

  it('names the copy that shadows what it just installed', async () => {
    // The failure prepending would have caused, caught where a person can read
    // it: an install landed, and the binary that answers is still another one.
    // Silence here is a machine running a version nobody chose.
    const machine = createFakeMachine({
      programs: { 'claude version': printed('1.0.0'), 'claude whoami': printed('') },
      installers: [
        {
          argv: `fakepkg add --into ${PREFIX} claude`,
          first: printed('9.9.9'),
          again: printed('9.9.9'),
          // The install put 9.9.9 there and `claude` still resolves to 1.0.0.
          programs: {},
        },
      ],
    });

    const outcome = await applySetupPlan(
      serverPlan({ providers: [{ provider: 'claude', version: '9.9.9' }] }),
      dependencies(machine, { providers: createProviderRegistry([createFakeProviderAdapter()]) }),
    );

    expect(outcome.server?.providers[0]).toMatchObject({ action: 'installed', version: '1.0.0' });
    expect(outcome.problems).toEqual([expect.stringContaining('9.9.9')]);
  });

  it('reports an install the installer refused, in the installer’s own words', async () => {
    // npm's message names the version that does not exist. "npm exited 1" would
    // leave an operator to guess which of the plan's fields is wrong.
    const machine = createFakeMachine({
      programs: {
        [npmInstall('0.0.0')]: {
          kind: 'exited',
          exitCode: 1,
          stdout: NPM_NO_SUCH_VERSION,
          stderr: '',
        },
      },
    });

    const outcome = await applySetupPlan(
      serverPlan({ providers: [{ provider: 'claude', version: '0.0.0' }] }),
      dependencies(machine),
    );

    expect(outcome.server?.providers[0]).toMatchObject({
      action: 'none',
      version: null,
      authState: null,
    });
    expect(outcome.problems).toEqual([expect.stringContaining('0.0.0')]);
  });

  it('lets a provider this build cannot drive cost itself and not the run', async () => {
    // `codex` is a provider agentplex knows and this build has no adapter for,
    // which is the build's own limit. The store still gets an id, the identity
    // is still minted, and claude is still provisioned.
    const machine = machineWithClaude();

    const outcome = await applySetupPlan(
      serverPlan({
        providers: [
          { provider: 'codex', version: null },
          { provider: 'claude', version: null },
        ],
      }),
      dependencies(machine),
    );

    expect(outcome.server?.providers.map((one) => one.action)).toEqual(['none', 'adopted']);
    expect(outcome.problems).toEqual([expect.stringContaining('codex')]);
    expect(outcome.server?.identity.minted).toBe(true);
    expect(outcome.server?.stores[0]).toMatchObject({ ok: true });
  });

  it('reports a provider that cannot answer whether it is logged in', async () => {
    // Not a logout. A `claude` behind a wrapper, or a release that stopped
    // printing this, is a different fact from a logged-out one, and reporting it
    // as logged out sends an operator through a login that fails for a reason
    // nobody named.
    const machine = machineWithClaude(printed('command not found\n'));

    const outcome = await applySetupPlan(serverPlan(), dependencies(machine));

    expect(outcome.server?.providers[0]).toMatchObject({ action: 'adopted', authState: null });
    expect(outcome.problems).toEqual([expect.stringContaining('claude')]);
  });

  it('keeps a store it cannot read in the listing, and provisions the rest', async () => {
    const files = createFakeStoreFiles({ unreadable: [join('/srv/broken', STORE_FILE_NAME)] });

    const outcome = await applySetupPlan(
      serverPlan({ storePaths: ['/srv/broken', STORE] }),
      dependencies(machineWithClaude(), { files }),
    );

    expect(outcome.server?.stores).toMatchObject([
      { ok: false, path: '/srv/broken' },
      { ok: true },
    ]);
    expect(outcome.problems).toEqual([expect.stringContaining('/srv/broken')]);
  });

  it('records the directories the server should resolve programs in', async () => {
    const outcome = await applySetupPlan(
      serverPlan({ binPath: ['/opt/homebrew/bin'] }),
      dependencies(machineWithClaude()),
    );

    expect(outcome.server?.binPath).toEqual(['/opt/homebrew/bin', join(PREFIX, 'bin')]);
    expect(outcome.server?.port).toBe(8081);
  });

  it('provisions nothing for a hub, which starts no agents', async () => {
    const machine = createFakeMachine();
    const files = createFakeStoreFiles();

    const outcome = await applySetupPlan(parseHubPlan(), dependencies(machine, { files }));

    expect(outcome).toEqual({ role: 'hub', hub: { port: 8080 }, server: null, problems: [] });
    expect(machine.requests).toEqual([]);
    expect(files.creates).toEqual([]);
  });
});

function parseHubPlan(): SetupPlan {
  const parsed = parseSetupPlan(
    JSON.stringify({ version: SETUP_PLAN_VERSION, role: 'hub', hub: { port: 8080 } }),
  );
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.plan;
}
