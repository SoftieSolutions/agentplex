import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../fake-process-probe.js';
import type { CompletedProcess } from '../operations/process-runner.js';
import { CLAUDE_PROJECTS_DIRECTORY, createClaudeAdapter } from './claude-adapter.js';
import { CLAUDE_PACKAGE, createClaudeProvisioning } from './claude-provisioning.js';
import { createFakeProviderFiles } from './fake-provider-files.js';
import type { InstallPlan, OneShotPlan } from './provider-adapter.js';

/**
 * The fixtures are captured output of the two programs this file plans.
 *
 * `npm-install-added.json` is `npm install --global --prefix <dir> --json
 * @anthropic-ai/claude-code@2.1.259` into an empty prefix, `npm-install-up-to-
 * date.json` is the same command run a second time against the prefix it just
 * filled, and `npm-install-no-such-version.json` is npm's stdout for a version
 * that does not exist, which it answers with exit 1. `claude-version.txt` is
 * the whole of what `claude --version` prints, and the two
 * `claude-auth-status-*.json` files are `claude auth status --json` from a
 * logged-in machine (exit 0) and from the same machine with authentication
 * suppressed (exit 1).
 *
 * Two of them are why the rule says captured rather than written. A reinstall
 * of the version already on disk comes back with an empty `add`, a `changed`
 * count of two, and the package under `change[].to` — so a reader built on a
 * memory of "npm reports what it added" answers "npm installed nothing" every
 * time a reconciling setup is re-run. And `auth status` exits 1 while printing
 * a perfectly good `"loggedIn": false`, so a reader that checked the exit code
 * first would never report a logout at all.
 *
 * The email, organisation and home directory in the logged-in capture are
 * REDACTED on purpose: they are personal identifiers and this repository is
 * public. Nothing in the parser reads them, so nobody needs to "fix" the
 * fixture by pasting real ones back — doing that would publish somebody's
 * account details for no test coverage at all.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const NPM_ADDED = fixture('npm-install-added.json');
const NPM_UP_TO_DATE = fixture('npm-install-up-to-date.json');
const NPM_NO_SUCH_VERSION = fixture('npm-install-no-such-version.json');
const CLAUDE_VERSION = fixture('claude-version.txt');
const AUTH_LOGGED_IN = fixture('claude-auth-status-logged-in.json');
const AUTH_LOGGED_OUT = fixture('claude-auth-status-logged-out.json');

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const CWD = '/Users/dev/Code/agentplex';
const PREFIX = '/Users/dev/.agentplex';
const VERSION = '2.1.259';

function exited(exitCode: number, stdout: string, stderr = ''): CompletedProcess {
  return { exitCode, stdout, stderr };
}

/** The plan an install request produces, or a failure that names the refusal. */
function planned(install: InstallPlan): OneShotPlan<{ package: string; version: string }> {
  if (!install.ok) throw new Error(`expected a plan, got a refusal: ${install.problem}`);
  return install.plan;
}

describe('createClaudeProvisioning.install', () => {
  it('installs the pinned version into the prefix, as one argv and nothing else', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    // Spelled out rather than derived from the code under test: a test that
    // asks the implementation what it does and then agrees checks nothing.
    expect(plan.argv).toEqual({
      file: 'npm',
      args: ['install', '--global', '--prefix', PREFIX, '--json', `${CLAUDE_PACKAGE}@${VERSION}`],
    });
  });

  it('asks for the latest when the request pins no version', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: null }));

    expect(plan.argv.args.at(-1)).toBe(`${CLAUDE_PACKAGE}@latest`);
  });

  it('carries no working directory, no environment and no shell', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    // The assertion the ticket exists for, stated as itself. The prefix is an
    // argument npm parses, so there is nothing left for a cwd to do, and a plan
    // with nowhere to put one cannot grow one by accident. `shell` is absent
    // for the same structural reason: the process seam has no field for it.
    expect(Object.keys(plan).sort()).toEqual(['argv', 'read', 'timeoutMs']);
    expect(Object.keys(plan.argv).sort()).toEqual(['args', 'file']);
    expect(plan.argv.args).toContain(PREFIX);
  });

  it('passes no flag as anything but its own argv element', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    // A joined string is the shape that only works with a shell, and there is
    // no shell anywhere on this path.
    for (const element of plan.argv.args) expect(element).not.toMatch(/^--\S+[ =]/);
  });

  it('refuses a prefix that is not an absolute path', () => {
    // A relative prefix resolves against whatever directory setup happened to
    // start in, which is exactly the ambiguity the missing cwd removes.
    const install = createClaudeProvisioning().install({ prefix: '.agentplex', version: null });

    expect(install.ok).toBe(false);
    expect(!install.ok && install.problem).toContain('absolute path');
  });

  it('refuses a prefix with a null byte in it', () => {
    // The NUL truncates the path at the syscall, so what npm writes into is a
    // prefix of what anybody checked.
    const install = createClaudeProvisioning().install({
      prefix: '/Users/dev/.agentplex\0/etc',
      version: null,
    });

    expect(install.ok).toBe(false);
    expect(!install.ok && install.problem).toContain('null byte');
  });

  it('reads the package and version out of a real install', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(0, NPM_ADDED))).toEqual({
      ok: true,
      result: { package: CLAUDE_PACKAGE, version: VERSION },
    });
  });

  it('reads a reinstall that changed nothing as the install it is', () => {
    // The captured case that a hand-written fixture would have missed: `add` is
    // empty and the package is under `change[].to`. Reporting this as a failed
    // install would make every re-run of setup look broken.
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(0, NPM_UP_TO_DATE))).toEqual({
      ok: true,
      result: { package: CLAUDE_PACKAGE, version: VERSION },
    });
  });

  it("refuses with npm's own words when the version does not exist", () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: '0.0.0' }));

    const read = plan.read(exited(1, NPM_NO_SUCH_VERSION, 'npm error code ETARGET\n'));

    expect(read.ok).toBe(false);
    // npm's summary names the thing to change. "npm exited 1" does not.
    expect(!read.ok && read.problem).toContain('No matching version found');
  });

  it('refuses output that is not the format npm was asked for', () => {
    // A corporate npm shim or a proxy login page in front of the registry is
    // the actual thing an operator has to deal with, and an exit code alone
    // hides it.
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    const read = plan.read(exited(0, '<html>Proxy authentication required</html>\n'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('no JSON');
  });

  it('refuses an install that exited 0 without reporting this package', () => {
    const plan = planned(createClaudeProvisioning().install({ prefix: PREFIX, version: VERSION }));

    const read = plan.read(exited(0, '{"add":[],"added":0,"change":[],"changed":0}'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain(CLAUDE_PACKAGE);
  });
});

describe('createClaudeProvisioning.version', () => {
  it('asks claude for its version, and nothing else', () => {
    const probe = createClaudeProvisioning().version();

    expect(probe.argv).toEqual({ file: 'claude', args: ['--version'] });
    expect(Object.keys(probe).sort()).toEqual(['argv', 'read', 'timeoutMs']);
    expect(Object.keys(probe.argv).sort()).toEqual(['args', 'file']);
  });

  it('takes the version out of what claude actually prints', () => {
    // `2.1.259 (Claude Code)`. The parenthesised name is not a promise, so only
    // the first word is read and the rest is left alone.
    const probe = createClaudeProvisioning().version();

    expect(probe.read(exited(0, CLAUDE_VERSION))).toEqual({ ok: true, result: '2.1.259' });
  });

  it('refuses output whose first word is not a version', () => {
    const probe = createClaudeProvisioning().version();

    const read = probe.read(exited(0, 'error: unknown option --version\n'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('no version');
  });

  it("refuses with the program's own stderr when it exits nonzero", () => {
    const probe = createClaudeProvisioning().version();

    const read = probe.read(exited(1, '', 'dyld: Library not loaded\n'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('dyld: Library not loaded');
  });
});

describe('createClaudeProvisioning.authState', () => {
  it('asks the provider, with --json spelled out', () => {
    const probe = createClaudeProvisioning().authState();

    // `--json` is the documented default in 2.1.259 and is passed anyway, for
    // the reason `shell: false` is written down rather than relied on: changing
    // a default is invisible, and changing this line is not.
    expect(probe.argv).toEqual({ file: 'claude', args: ['auth', 'status', '--json'] });
    expect(Object.keys(probe).sort()).toEqual(['argv', 'read', 'timeoutMs']);
    expect(Object.keys(probe.argv).sort()).toEqual(['args', 'file']);
  });

  it('never names the credentials file', () => {
    // The decision this replaced. `<store>/.credentials.json` is an
    // undocumented format inside a directory the provider owns, absent entirely
    // where the credentials went into an OS keychain, and free to change shape
    // in any release. Nothing here reads it, and this test is what fails if
    // somebody adds it back as an optimisation.
    const probe = createClaudeProvisioning().authState();

    for (const element of probe.argv.args) expect(element).not.toContain('credentials');
  });

  it('reports a logged-in provider from what the provider actually printed', () => {
    const probe = createClaudeProvisioning().authState();

    expect(probe.read(exited(0, AUTH_LOGGED_IN))).toEqual({ ok: true, result: 'authenticated' });
  });

  it('reads logged out out of an exit code that says failure', () => {
    // The captured detail, and the reason this fixture exists: 2.1.259 exits 1
    // while printing `"loggedIn": false`. A reader that refused on a nonzero
    // exit — the obvious way to write one — would turn every logged-out
    // provider into "the probe could not run" and lose the single fact setup
    // exists to act on. Same lesson as `git status` exiting 128 on a directory
    // that is simply not a repository.
    const probe = createClaudeProvisioning().authState();

    expect(probe.read(exited(1, AUTH_LOGGED_OUT))).toEqual({
      ok: true,
      result: 'unauthenticated',
    });
  });

  it('ignores every field but the one it asked about', () => {
    // The account's email, organisation and subscription are in the captured
    // output and are none of this probe's business. Reading them would also
    // make the parser refuse the next release that moves one.
    const probe = createClaudeProvisioning().authState();

    expect(probe.read(exited(0, '{"loggedIn":true,"newFieldFromAFutureRelease":42}'))).toEqual({
      ok: true,
      result: 'authenticated',
    });
  });

  it('refuses rather than calling an unanswerable probe a logout', () => {
    // A `claude` that is not there, a wrapper in front of it, or a release that
    // stopped printing this are different facts from "logged out", and
    // flattening them sends an operator through a login that fails for the
    // reason nobody named.
    const probe = createClaudeProvisioning().authState();

    const read = probe.read(exited(1, '', 'command not found: claude\n'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('command not found');
  });

  it('refuses output that is not the format it asked for', () => {
    const probe = createClaudeProvisioning().authState();

    expect(probe.read(exited(0, 'Logged in as someone\n')).ok).toBe(false);
    expect(probe.read(exited(0, '{"loggedIn":"yes"}')).ok).toBe(false);
  });
});

describe('createClaudeProvisioning.login', () => {
  it("runs the provider's own login, pointed at the store it must write into", () => {
    const login = createClaudeProvisioning().login({ store: STORE, cwd: CWD });

    expect(login).toEqual({
      ok: true,
      plan: {
        command: 'claude',
        args: ['auth', 'login'],
        cwd: CWD,
        // Without this the login lands in whichever home directory agentplexd
        // runs as, and the store the sessions will use is exactly as logged out
        // as it was, with nothing saying so.
        env: { CLAUDE_CONFIG_DIR: STORE.path },
        scrubEnvPrefixes: ['CLAUDE', 'AI_AGENT'],
      },
    });
  });

  it('refuses a working directory inside the store, like every other launch', () => {
    const login = createClaudeProvisioning().login({
      store: STORE,
      cwd: `${STORE.path}/${CLAUDE_PROJECTS_DIRECTORY}`,
    });

    expect(login.ok).toBe(false);
    expect(!login.ok && login.problem).toContain('inside the store');
  });

  it('refuses a working directory that is not an absolute path', () => {
    const login = createClaudeProvisioning().login({ store: STORE, cwd: 'Code/agentplex' });

    expect(login.ok).toBe(false);
  });
});

describe('createClaudeAdapter.provisioning', () => {
  it('is what the Claude adapter answers with, so the seam is reached through it', () => {
    // Provisioning is on the adapter because that is where a caller holding a
    // provider looks for it. Reaching it any other way would mean the setup
    // path had its own map of provider to installer, which is the map the seam
    // exists to delete.
    const adapter = createClaudeAdapter({
      files: createFakeProviderFiles(),
      probe: createFakeProcessProbe({}),
    });

    expect(adapter.provisioning.version().argv).toEqual({ file: 'claude', args: ['--version'] });
    expect(adapter.provisioning.authState().argv).toEqual({
      file: 'claude',
      args: ['auth', 'status', '--json'],
    });
    expect(adapter.provisioning.login({ store: STORE, cwd: CWD })).toEqual(
      createClaudeProvisioning().login({ store: STORE, cwd: CWD }),
    );
  });
});
