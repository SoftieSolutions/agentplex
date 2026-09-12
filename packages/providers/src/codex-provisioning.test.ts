import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { CODEX_COMMAND, CODEX_HOME, CODEX_SCRUB_PREFIXES } from './codex-launch.js';
import { CODEX_PACKAGE, createCodexProvisioning } from './codex-provisioning.js';
import type { CompletedProcess } from './operations/process-runner.js';
import type { InstallPlan, OneShotPlan } from './provider-adapter.js';

/**
 * The fixtures are captured output of the two programs this file plans.
 *
 * `codex-install-added.json` is `npm install --global --prefix <dir> --json
 * @openai/codex@0.154.0` into an empty prefix, `codex-install-up-to-date.json`
 * is the same command run a second time against the prefix it just filled, and
 * `codex-install-no-such-version.json` is npm's stdout for a version that does
 * not exist, which it answers with exit 1. `codex-version.txt` is the whole of
 * what `codex --version` prints, and the two `codex-login-status-*.txt` files
 * are what `codex login status` writes on a logged-in store (exit 0) and on an
 * empty one (exit 1).
 *
 * Three of them are why the rule says captured rather than written.
 *
 * `codex --version` prints `codex-cli 0.154.0` — the version is the *second*
 * word, where Claude Code's is the first. A reader copied across from that
 * adapter reports `codex-cli` as the version, which is the kind of thing that
 * gets shipped because it looks like it works.
 *
 * `codex login status` writes its answer to **stderr** and prints nothing at
 * all on stdout, in both directions. A reader that looked where every other
 * probe in this package looks would find an empty string and conclude the
 * provider could not answer, for a provider that answered perfectly well.
 *
 * And `codex-install-added.json` has no `unreviewedScripts` in it, because
 * `@openai/codex` has no `scripts` at all: it ships per-platform binaries as
 * optional dependencies rather than fetching one in a postinstall. That is why
 * the install plan below carries no `--no-ignore-scripts`, and it is the case
 * the provider seam predicted out loud — the flag is Claude Code's answer to
 * the postinstall question and not agentplex policy.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const NPM_ADDED = fixture('codex-install-added.json');
const NPM_UP_TO_DATE = fixture('codex-install-up-to-date.json');
const NPM_NO_SUCH_VERSION = fixture('codex-install-no-such-version.json');
const CODEX_VERSION_OUTPUT = fixture('codex-version.txt');
const LOGIN_STATUS_LOGGED_IN = fixture('codex-login-status-logged-in.txt');
const LOGIN_STATUS_LOGGED_OUT = fixture('codex-login-status-logged-out.txt');

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/codex' });
const CWD = '/Users/dev/Code/agentplex';
const PREFIX = '/Users/dev/.agentplex';
const VERSION = '0.154.0';

function exited(exitCode: number, stdout: string, stderr = ''): CompletedProcess {
  return { exitCode, stdout, stderr };
}

function planned(install: InstallPlan): OneShotPlan<{ package: string; version: string }> {
  if (!install.ok) throw new Error(`expected a plan, got a refusal: ${install.problem}`);
  return install.plan;
}

describe('createCodexProvisioning.install', () => {
  it('installs the pinned version into the prefix, as one argv and nothing else', () => {
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: VERSION }));

    // Spelled out rather than derived from the code under test, and with no
    // `--no-ignore-scripts`: this package has no install script to run.
    expect(plan.argv).toEqual({
      file: 'npm',
      args: ['install', '--global', '--prefix', PREFIX, '--json', `${CODEX_PACKAGE}@${VERSION}`],
    });
  });

  it('asks npm for the current release when nothing is pinned', () => {
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: null }));

    expect(plan.argv.args.at(-1)).toBe(`${CODEX_PACKAGE}@latest`);
  });

  it('refuses a prefix that is not an absolute path', () => {
    const install = createCodexProvisioning().install({ prefix: 'somewhere', version: null });

    expect(install).toMatchObject({ ok: false });
  });

  it('refuses a prefix carrying a null byte', () => {
    const install = createCodexProvisioning().install({ prefix: '/srv/bin\0/etc', version: null });

    expect(install).toMatchObject({ ok: false });
  });

  it('reads what npm says it added', () => {
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(0, NPM_ADDED))).toEqual({
      ok: true,
      result: { package: CODEX_PACKAGE, version: VERSION },
    });
  });

  it('reads a reinstall of the version already there, which npm reports as a change', () => {
    // The case a reconciling setup hits most, and the one a reader built on
    // `add` alone answers "npm installed nothing" for.
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(0, NPM_UP_TO_DATE))).toEqual({
      ok: true,
      result: { package: CODEX_PACKAGE, version: VERSION },
    });
  });

  it("hands the operator npm's own words when a version does not exist", () => {
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: '0.0.0' }));

    expect(plan.read(exited(1, NPM_NO_SUCH_VERSION))).toEqual({
      ok: false,
      problem: `npm could not install ${CODEX_PACKAGE}: No matching version found for @openai/codex@0.0.0.`,
    });
  });

  it('says so when npm printed something that is not the JSON it was asked for', () => {
    // A corporate npm shim or a proxy login page is the actual thing an
    // operator has to deal with, and an exit code alone hides it.
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(1, 'ERR! proxy authentication required'))).toMatchObject({
      ok: false,
    });
  });

  it('refuses an install that exited 0 without reporting this package', () => {
    const plan = planned(createCodexProvisioning().install({ prefix: PREFIX, version: VERSION }));

    expect(plan.read(exited(0, '{"add":[],"change":[]}'))).toEqual({
      ok: false,
      problem: `npm exited 0 without reporting ${CODEX_PACKAGE}`,
    });
  });
});

describe('createCodexProvisioning.version', () => {
  it('asks codex, and reads the version out of what it printed', () => {
    const probe = createCodexProvisioning().version();

    expect(probe.argv).toEqual({ file: CODEX_COMMAND, args: ['--version'] });
    expect(probe.read(exited(0, CODEX_VERSION_OUTPUT))).toEqual({ ok: true, result: '0.154.0' });
  });

  it('does not mistake the product name it prints first for a version', () => {
    // `codex-cli 0.154.0`. Claude Code prints `2.1.259 (Claude Code)`, the
    // other way round, so the word this reader takes is the one that looks
    // like a version rather than the one in a fixed position.
    const probe = createCodexProvisioning().version();

    expect(probe.read(exited(0, CODEX_VERSION_OUTPUT))).not.toMatchObject({
      result: 'codex-cli',
    });
  });

  it('refuses rather than inventing a version when codex printed none', () => {
    const probe = createCodexProvisioning().version();

    expect(probe.read(exited(0, 'command not found'))).toMatchObject({ ok: false });
  });

  it('says what codex said when the probe exited nonzero', () => {
    const probe = createCodexProvisioning().version();

    expect(probe.read(exited(1, '', 'dyld: Library not loaded'))).toEqual({
      ok: false,
      problem: 'codex could not report its version: dyld: Library not loaded',
    });
  });
});

describe('createCodexProvisioning.authState', () => {
  it('asks codex whether it is logged in, and reads the answer off stderr', () => {
    const probe = createCodexProvisioning().authState();

    expect(probe.argv).toEqual({ file: CODEX_COMMAND, args: ['login', 'status'] });
    expect(probe.read(exited(0, '', LOGIN_STATUS_LOGGED_IN))).toEqual({
      ok: true,
      result: 'authenticated',
    });
  });

  it('reports a logout that codex reported by exiting 1', () => {
    // The same lesson `claude auth status` taught: a provider answers the
    // question and calls the answer a failure at the same time. A reader that
    // refused on a nonzero exit would turn every logged-out store into "the
    // probe could not run" and lose the one fact setup exists to act on.
    const probe = createCodexProvisioning().authState();

    expect(probe.read(exited(1, '', LOGIN_STATUS_LOGGED_OUT))).toEqual({
      ok: true,
      result: 'unauthenticated',
    });
  });

  it('recognises the other ways codex says it is logged in', () => {
    // 0.154.0 carries six of these — ChatGPT, an API key, an access token, a
    // personal access token, workload identity, and two Amazon Bedrock
    // spellings — so the rule is the prefix and not the whole sentence.
    const probe = createCodexProvisioning().authState();

    for (const said of [
      'Logged in using an API key - sk-REDACTED\n',
      'Logged in using workload identity\n',
      'Logged in using Amazon Bedrock AWS access keys\n',
    ]) {
      expect(probe.read(exited(0, '', said))).toEqual({ ok: true, result: 'authenticated' });
    }
  });

  it('does not read "Not logged in" as a login because it contains the words', () => {
    const probe = createCodexProvisioning().authState();

    expect(probe.read(exited(1, '', 'Not logged in\n'))).toEqual({
      ok: true,
      result: 'unauthenticated',
    });
  });

  it('finds the answer under a warning codex printed on the way to it', () => {
    // Not hypothetical, and not something any of the fixtures beside this file
    // could have shown. Driving `agentplex setup` end to end against a codex it
    // had just installed, the probe came back with this — the warning first and
    // the answer under it — and the reader, which took stderr's first line,
    // reported that codex had not answered. The text below is what that run
    // printed, with the machine's own temp path shortened.
    const probe = createCodexProvisioning().authState();
    const warned = [
      'WARNING: proceeding, even though we could not create PATH aliases:',
      'Refusing to create helper binaries under temporary dir "/var/folders/T/"',
      'Not logged in',
      '',
    ].join('\n');

    expect(probe.read(exited(1, '', warned))).toEqual({ ok: true, result: 'unauthenticated' });
  });

  it('quotes the end of what codex said, not the warning it opened with', () => {
    // A program that warns and then fails says why at the end. An operator
    // shown the warning is shown the thing that did not matter.
    const probe = createCodexProvisioning().authState();
    const warned = ['WARNING: could not create PATH aliases', 'error: no such subcommand'].join(
      '\n',
    );

    expect(probe.read(exited(2, '', warned))).toEqual({
      ok: false,
      problem: 'codex did not report its authentication state: error: no such subcommand',
    });
  });

  it('refuses rather than reporting a logout when codex said something else', () => {
    // A release that stopped printing this, or a wrapper in front of codex,
    // is a different fact from a logout, and flattening them sends an operator
    // through a login that fails for the reason nobody named.
    const probe = createCodexProvisioning().authState();

    expect(probe.read(exited(2, '', 'error: unexpected argument'))).toMatchObject({ ok: false });
  });
});

describe('createCodexProvisioning.login', () => {
  it('drives the device-code flow, in the store the sessions will run against', () => {
    const login = createCodexProvisioning().login({ store: STORE, cwd: CWD });

    expect(login).toEqual({
      ok: true,
      plan: {
        command: CODEX_COMMAND,
        args: ['login', '--device-auth'],
        cwd: CWD,
        env: { [CODEX_HOME]: STORE.path },
        scrubEnvPrefixes: CODEX_SCRUB_PREFIXES,
      },
    });
  });

  it('refuses a login with nowhere to open the terminal', () => {
    const login = createCodexProvisioning().login({ store: STORE, cwd: '' });

    expect(login).toMatchObject({ ok: false });
  });
});
