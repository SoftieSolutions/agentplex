import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmInstallSpec, parseNpmPrefix, readNpmInstall } from './npm-install.js';
import type { CompletedProcess } from './operations/process-runner.js';

/**
 * The same captured npm runs the two provisioning suites read, and that is the
 * point of this file.
 *
 * `npm-install-*.json` came from installing `@anthropic-ai/claude-code` and
 * `codex-install-*.json` from installing `@openai/codex`, both through the
 * argv their adapters build. Nothing here is re-captured or hand-written: if
 * this parser is the one parser for npm's `--json` install report, then the
 * evidence it is checked against is every install this repository has
 * captured, whoever captured it.
 *
 * Reading both here is also what stops the shared parser from quietly becoming
 * one provider's parser that the other one happens to survive. The codex
 * capture is the one that carries a platform package under a version no
 * release is called -- `0.154.0-darwin-arm64` -- so it is the capture that
 * fails if this ever starts taking the first entry instead of the named one.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_VERSION = '2.1.259';
const CODEX_PACKAGE = '@openai/codex';
const CODEX_VERSION = '0.154.0';

const CLAUDE_ADDED = fixture('npm-install-added.json');
const CLAUDE_UP_TO_DATE = fixture('npm-install-up-to-date.json');
const CLAUDE_NO_SUCH_VERSION = fixture('npm-install-no-such-version.json');
const CLAUDE_STRICT_ALLOW_SCRIPTS = fixture('npm-install-strict-allow-scripts.json');
const CODEX_ADDED = fixture('codex-install-added.json');
const CODEX_UP_TO_DATE = fixture('codex-install-up-to-date.json');
const CODEX_NO_SUCH_VERSION = fixture('codex-install-no-such-version.json');

function exited(exitCode: number, stdout: string, stderr = ''): CompletedProcess {
  return { exitCode, stdout, stderr };
}

describe('npmInstallSpec', () => {
  it('pins the version the request named, as one argv element', () => {
    expect(npmInstallSpec(CLAUDE_PACKAGE, CLAUDE_VERSION)).toBe(
      `${CLAUDE_PACKAGE}@${CLAUDE_VERSION}`,
    );
  });

  it('asks for the dist-tag by name when nothing is pinned', () => {
    // `npm install <pkg>` and `npm install <pkg>@latest` mean the same thing,
    // and building one shape for both means there is one shape to read in a log
    // line and one shape a test asserts on.
    expect(npmInstallSpec(CODEX_PACKAGE, null)).toBe(`${CODEX_PACKAGE}@latest`);
  });
});

describe('parseNpmPrefix', () => {
  it('takes an absolute path', () => {
    expect(parseNpmPrefix('/Users/dev/.agentplex')).toEqual({
      ok: true,
      prefix: '/Users/dev/.agentplex',
    });
  });

  it('refuses a relative prefix', () => {
    // It would resolve against whatever directory the setup process happened to
    // start in, which is the ambiguity the missing cwd exists to remove.
    const parsed = parseNpmPrefix('.agentplex');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toContain('absolute path');
  });

  it('refuses a prefix with a null byte in it', () => {
    // The NUL truncates the path at the syscall, so what npm writes into is a
    // prefix of what anybody checked.
    const parsed = parseNpmPrefix('/Users/dev/.agentplex\0/etc');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toContain('null byte');
  });
});

describe('readNpmInstall', () => {
  it('reads the package and version out of a real install', () => {
    expect(readNpmInstall(CLAUDE_PACKAGE)(exited(0, CLAUDE_ADDED))).toEqual({
      ok: true,
      result: { package: CLAUDE_PACKAGE, version: CLAUDE_VERSION },
    });
    expect(readNpmInstall(CODEX_PACKAGE)(exited(0, CODEX_ADDED))).toEqual({
      ok: true,
      result: { package: CODEX_PACKAGE, version: CODEX_VERSION },
    });
  });

  it('reads a reinstall that changed nothing as the install it is', () => {
    // The captured case a hand-written fixture would have missed, and the one a
    // reconciling setup hits most: `add` is empty and the package is under
    // `change[].to`. Both programs answer this way, which is the evidence that
    // it is npm's shape rather than either provider's.
    expect(readNpmInstall(CLAUDE_PACKAGE)(exited(0, CLAUDE_UP_TO_DATE))).toEqual({
      ok: true,
      result: { package: CLAUDE_PACKAGE, version: CLAUDE_VERSION },
    });
    expect(readNpmInstall(CODEX_PACKAGE)(exited(0, CODEX_UP_TO_DATE))).toEqual({
      ok: true,
      result: { package: CODEX_PACKAGE, version: CODEX_VERSION },
    });
  });

  it('takes the named package and not the platform one npm reports beside it', () => {
    // `@openai/codex-darwin-arm64` is in this capture at a version spelled
    // `0.154.0-darwin-arm64`, and an operator shown that version would be shown
    // something no release is called.
    const read = readNpmInstall(CODEX_PACKAGE)(exited(0, CODEX_ADDED));

    expect(read).toMatchObject({ result: { package: CODEX_PACKAGE } });
    expect(read.ok && read.result.version).not.toContain('darwin');
  });

  it("refuses with npm's own words when the version does not exist", () => {
    // npm's summary names the thing to change. "npm exited 1" does not.
    expect(readNpmInstall(CLAUDE_PACKAGE)(exited(1, CLAUDE_NO_SUCH_VERSION))).toEqual({
      ok: false,
      problem: `npm could not install ${CLAUDE_PACKAGE}: No matching version found for @anthropic-ai/claude-code@0.0.0-does-not-exist.`,
    });
    expect(readNpmInstall(CODEX_PACKAGE)(exited(1, CODEX_NO_SUCH_VERSION))).toEqual({
      ok: false,
      problem: `npm could not install ${CODEX_PACKAGE}: No matching version found for @openai/codex@0.0.0.`,
    });
  });

  it("carries npm's own remediation when a machine's npmrc forbids install scripts", () => {
    // npm 11.19 refusing the install on a machine whose npmrc sets
    // `strict-allow-scripts`: ESTRICTALLOWSCRIPTS on stdout under --json,
    // naming the package, the script and three ways to proceed. It is passed
    // through verbatim, which is a better outcome than agentplex quietly
    // deciding on the operator's behalf that their hardening does not apply.
    const read = readNpmInstall(CLAUDE_PACKAGE)(
      exited(1, CLAUDE_STRICT_ALLOW_SCRIPTS, 'npm error code ESTRICTALLOWSCRIPTS\n'),
    );

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('install scripts not covered by allowScripts');
    expect(!read.ok && read.problem).toContain('--allow-scripts');
  });

  it('names the exit code when npm failed without an error object', () => {
    const read = readNpmInstall(CODEX_PACKAGE)(exited(137, '{"add":[]}'));

    expect(read).toEqual({
      ok: false,
      problem: `npm could not install ${CODEX_PACKAGE}: it exited 137`,
    });
  });

  it('refuses output that is not the format npm was asked for', () => {
    // A corporate npm shim or a proxy login page in front of the registry is
    // the actual thing an operator has to deal with, and an exit code alone
    // hides it.
    const read = readNpmInstall(CLAUDE_PACKAGE)(
      exited(0, '<html>Proxy authentication required</html>\n'),
    );

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('no JSON');
    expect(!read.ok && read.problem).toContain('Proxy authentication required');
  });

  it('quotes stderr when npm printed nothing at all on stdout', () => {
    const read = readNpmInstall(CODEX_PACKAGE)(exited(1, '', 'npm error code ENOTFOUND\n'));

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('ENOTFOUND');
  });

  it('refuses JSON that is not an install report', () => {
    const read = readNpmInstall(CLAUDE_PACKAGE)(exited(0, '{"add":"everything"}'));

    expect(read).toEqual({ ok: false, problem: 'npm printed JSON that is not an install report' });
  });

  it('refuses an install that exited 0 without reporting this package', () => {
    // npm exited 0 having done something that did not include this package.
    // Saying it was installed would put a version in front of an operator that
    // nothing on disk backs.
    expect(readNpmInstall(CLAUDE_PACKAGE)(exited(0, '{"add":[],"change":[]}'))).toEqual({
      ok: false,
      problem: `npm exited 0 without reporting ${CLAUDE_PACKAGE}`,
    });
  });

  it('answers about the package it was asked about and no other', () => {
    // The parameter is the whole of what differs between the two callers, so
    // this is the assertion that says so: codex's own capture, read while
    // asking about Claude Code, is not an install of Claude Code.
    const read = readNpmInstall(CLAUDE_PACKAGE)(exited(0, CODEX_ADDED));

    expect(read).toEqual({
      ok: false,
      problem: `npm exited 0 without reporting ${CLAUDE_PACKAGE}`,
    });
  });
});
