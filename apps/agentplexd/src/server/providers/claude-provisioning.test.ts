import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../fake-process-probe.js';
import type { CompletedProcess } from '../operations/process-runner.js';
import { CLAUDE_PROJECTS_DIRECTORY, createClaudeAdapter } from './claude-adapter.js';
import {
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_PACKAGE,
  createClaudeProvisioning,
} from './claude-provisioning.js';
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
 * the whole of what `claude --version` prints.
 *
 * The second one is why these are captured rather than written. A reinstall of
 * the version already on disk comes back with an empty `add`, a `changed` count
 * of two, and the package under `change[].to` — so a reader written from a
 * memory of "npm reports what it added" answers "npm installed nothing" every
 * time a reconciling setup is re-run, which is the case it will meet most.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const NPM_ADDED = fixture('npm-install-added.json');
const NPM_UP_TO_DATE = fixture('npm-install-up-to-date.json');
const NPM_NO_SUCH_VERSION = fixture('npm-install-no-such-version.json');
const CLAUDE_VERSION = fixture('claude-version.txt');

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

/**
 * A credentials file, in the shape Claude Code 2.1.259 writes.
 *
 * The field list is captured from the CLI rather than remembered: the binary
 * builds the stored object as `{accessToken, refreshToken, expiresAt,
 * refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier, clientId}`
 * under `claudeAiOauth`. The values are not captured and must not be: a real
 * one holds a live token, and a fixture of somebody's credentials is a
 * credential in the repository.
 */
const CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-not-a-real-token',
    refreshToken: 'sk-ant-ort01-not-a-real-token',
    expiresAt: 1_759_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
});

describe('createClaudeProvisioning.authState', () => {
  it('reads the credentials file at the store root and no other file', () => {
    expect(createClaudeProvisioning().authState().file).toBe(CLAUDE_CREDENTIALS_FILE);
    // Relative, so the caller joins it to the store it asked about. An adapter
    // that returned an absolute path would be an adapter that had to be told
    // where the store is to answer a question that is the same everywhere.
    expect(CLAUDE_CREDENTIALS_FILE.startsWith('/')).toBe(false);
  });

  it('reports a stored credential as logged in', () => {
    const probe = createClaudeProvisioning().authState();

    expect(probe.read({ kind: 'read', contents: CREDENTIALS })).toEqual({ kind: 'authenticated' });
  });

  it('reports an expired access token as logged in, because it refreshes', () => {
    // The same object carries a refresh token and Claude Code renews itself, so
    // an expired access token means a session that refreshes and not one that
    // needs a human. Reading expiry would also mean reading a clock, and this
    // has to stay a function of its argument.
    const probe = createClaudeProvisioning().authState();
    const expired = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-not-a-real-token', expiresAt: 1 },
    });

    expect(probe.read({ kind: 'read', contents: expired })).toEqual({ kind: 'authenticated' });
  });

  it('reports no credentials file as logged out', () => {
    const probe = createClaudeProvisioning().authState();

    expect(probe.read({ kind: 'missing' })).toEqual({ kind: 'unauthenticated' });
  });

  it('does not call a file it could not read a logout', () => {
    // A credentials file that is there and cannot be read is a permissions
    // problem somebody fixes in a second once it is named. Calling it "logged
    // out" sends them through a login that fails the same way for the same
    // unnamed reason.
    const probe = createClaudeProvisioning().authState();

    const state = probe.read({ kind: 'failed', reason: 'EACCES: permission denied' });

    expect(state.kind).toBe('unknown');
    expect(state.kind === 'unknown' && state.problem).toContain('EACCES');
  });

  it('does not call a file it cannot recognise a logout either', () => {
    const probe = createClaudeProvisioning().authState();

    expect(
      probe.read({ kind: 'read', contents: '{"apiKeyHelper":"/usr/local/bin/key"}' }).kind,
    ).toBe('unknown');
    expect(probe.read({ kind: 'read', contents: 'not json at all' }).kind).toBe('unknown');
  });

  it('never asks for a write of any kind', () => {
    // The rule the seam exists to hold: a probe is a path and a pure reader, so
    // there is no shape here in which setup could plant a credentials file.
    const probe = createClaudeProvisioning().authState();

    expect(Object.keys(probe).sort()).toEqual(['file', 'read']);
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
    expect(adapter.provisioning.authState().file).toBe(CLAUDE_CREDENTIALS_FILE);
    expect(adapter.provisioning.login({ store: STORE, cwd: CWD })).toEqual(
      createClaudeProvisioning().login({ store: STORE, cwd: CWD }),
    );
  });
});
