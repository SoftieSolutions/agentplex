import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { CompletedProcess } from '../operations/process-runner.js';
import type { FileRead } from '../store-identity.js';
import { planClaudeLaunch, CLAUDE_COMMAND } from './claude-launch.js';
import type {
  AuthProbe,
  AuthState,
  InstalledProvider,
  InstallPlan,
  InstallRequest,
  Launch,
  LoginRequest,
  OneShotRead,
  ProviderProvisioning,
  VersionProbe,
} from './provider-adapter.js';

/**
 * Provisioning Claude Code: where it comes from, what version is there, whether
 * it is logged in, and how to log it in.
 *
 * Every fact in this file is a fact about Claude Code specifically and about no
 * other provider — the npm package it ships as, the flag that prints its
 * version, the file it writes its credentials into, the subcommand that signs
 * in. That is the whole argument for putting provisioning on the seam: a second
 * provider is this file again with different answers, rather than four branches
 * added to an installer.
 *
 * Nothing here runs anything. Each method hands back a plan, and the setup
 * registry is what turns one into a child process.
 */

/** The npm package Claude Code ships as. */
export const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';

/** The installer, as a bare program name, resolved on PATH like every other. */
export const NPM_COMMAND = 'npm';

/**
 * The dist-tag npm resolves when a request pins no version.
 *
 * Named rather than left implicit, because the argv always carries a `<pkg>@`
 * suffix. `npm install <pkg>` and `npm install <pkg>@latest` mean the same
 * thing, and building one shape for both means there is one shape to read in a
 * log line and one shape a test asserts on.
 */
const NPM_LATEST_TAG = 'latest';

/**
 * Where Claude Code writes its credentials inside its config directory.
 *
 * Captured from the CLI rather than remembered: 2.1.259 resolves the path as
 * `join(configDir, ".credentials.json")`, where `configDir` is
 * `CLAUDE_CONFIG_DIR` or `~/.claude` — and the store agentplex points a session
 * at is that directory, so the file sits at the store root.
 */
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

/** `claude auth login`, the provider's own sign-in, driven in a terminal. */
const CLAUDE_LOGIN_ARGS: readonly string[] = ['auth', 'login'];

/**
 * Five minutes for an install.
 *
 * Generous on purpose, and still bounded. A global install of Claude Code pulls
 * the package and a platform-specific binary of it across a network that may be
 * a home connection or a cold EC2 instance, so a timeout tuned to a warm cache
 * would turn a slow link into "the machine said no". What the bound buys is
 * that a wedged registry connection ends as a refusal an operator can read
 * rather than a setup that never returns.
 */
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Ten seconds for a version probe.
 *
 * Not the two seconds a `git status` gets. This probe exists to catch the
 * version-manager shim that has to do work before the real binary runs, and a
 * shim that takes four seconds is a fact about the machine worth reporting, not
 * one worth timing out over.
 */
const VERSION_TIMEOUT_MS = 10_000;

export function createClaudeProvisioning(): ProviderProvisioning {
  return {
    install(request: InstallRequest): InstallPlan {
      const prefix = parsePrefix(request.prefix);
      if (!prefix.ok) return { ok: false, problem: prefix.problem };

      const spec = `${CLAUDE_PACKAGE}@${request.version ?? NPM_LATEST_TAG}`;

      return {
        ok: true,
        plan: {
          // `--prefix` and not a cwd, and `--json` and not the prose npm prints
          // for a person. The first is what lets an install go through a seam
          // that has nowhere to put a working directory; the second is what
          // lets the result be read rather than scraped. The package spec goes
          // last, as one element, so a version that arrived from a plan file
          // cannot become anything but a version.
          argv: {
            file: NPM_COMMAND,
            args: ['install', '--global', '--prefix', prefix.prefix, '--json', spec],
          },
          timeoutMs: INSTALL_TIMEOUT_MS,
          read: readNpmInstall,
        },
      };
    },

    version(): VersionProbe {
      return {
        argv: { file: CLAUDE_COMMAND, args: ['--version'] },
        timeoutMs: VERSION_TIMEOUT_MS,
        read: readClaudeVersion,
      };
    },

    authState(): AuthProbe {
      return { file: CLAUDE_CREDENTIALS_FILE, read: readClaudeCredentials };
    },

    login(request: LoginRequest): Launch {
      // The same launch a session gets, with different argv. That is the point
      // of sharing the builder: the login lands its credentials in this store
      // because `CLAUDE_CONFIG_DIR` is set the one way it is ever set, and it
      // is scrubbed of the nested-run markers for the same reason a session is.
      return planClaudeLaunch(request.store, request.cwd, CLAUDE_LOGIN_ARGS);
    },
  };
}

/**
 * A prefix this will build an argv out of.
 *
 * Absolute, because a relative prefix resolves against whatever directory the
 * setup process happens to have been started in — the exact ambiguity the
 * absence of a cwd on the process seam exists to remove — and because an
 * absolute path cannot be mistaken by npm for one of its own options. No NUL,
 * because a NUL truncates the path at the syscall, so what is written to is a
 * prefix of what was checked.
 */
function parsePrefix(
  prefix: string,
): { ok: true; prefix: string } | { ok: false; problem: string } {
  if (prefix.includes('\0')) {
    return { ok: false, problem: 'an install prefix may not contain a null byte' };
  }
  if (!isAbsolute(prefix)) {
    return { ok: false, problem: `an install prefix must be an absolute path, not ${prefix}` };
  }
  return { ok: true, prefix };
}

/**
 * What npm reports about a package under `--json`.
 *
 * Three fields out of the twelve npm prints, and a passthrough for the rest:
 * this is a format npm owns and extends, and a parser that insisted on the
 * whole shape would start refusing real output the next time npm adds a field.
 */
const npmPackageSchema = z.object({ name: z.string(), version: z.string() });

/**
 * The half of npm's `--json` output an install has to be read out of.
 *
 * `add` is what npm reports for a package that was not there. `change` is what
 * it reports for one that was — a reinstall of the version already on disk
 * comes back with an empty `add`, a `changed` count of two, and the package in
 * `change[].to`. That detail is exactly why this is read against captured
 * output: an install that reads only `add` reports "npm installed nothing"
 * every time setup is re-run, which is the case a reconciling setup hits most.
 */
const npmInstallSchema = z.object({
  add: z.array(npmPackageSchema).optional(),
  change: z.array(z.object({ to: npmPackageSchema })).optional(),
});

/**
 * npm's own error object, which it prints on stdout under `--json` while the
 * human-readable version goes to stderr.
 */
const npmErrorSchema = z.object({
  error: z.object({ code: z.string().nullish(), summary: z.string() }),
});

function readNpmInstall(completed: CompletedProcess): OneShotRead<InstalledProvider> {
  const json = parseJson(completed.stdout);
  if (json === undefined) {
    // npm printed something that is not the format it was asked for. Reporting
    // the exit code alone would hide a wrapper — a corporate npm shim, a proxy
    // login page — that is the actual thing an operator has to deal with.
    return {
      ok: false,
      problem: `npm printed no JSON: ${firstLine(completed.stdout) || firstLine(completed.stderr)}`,
    };
  }

  if (completed.exitCode !== 0) {
    // npm's own words. "No matching version found for @anthropic-ai/claude-
    // code@0.0.0" tells an operator what to change; "npm exited 1" does not.
    const failure = npmErrorSchema.safeParse(json);
    return {
      ok: false,
      problem: failure.success
        ? `npm could not install ${CLAUDE_PACKAGE}: ${failure.data.error.summary}`
        : `npm could not install ${CLAUDE_PACKAGE}: it exited ${completed.exitCode}`,
    };
  }

  const parsed = npmInstallSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, problem: 'npm printed JSON that is not an install report' };
  }

  const added = parsed.data.add ?? [];
  const changed = (parsed.data.change ?? []).map((change) => change.to);
  const installed = [...added, ...changed].find((entry) => entry.name === CLAUDE_PACKAGE);

  if (installed === undefined) {
    // npm exited 0 having done something that did not include this package.
    // Saying it was installed would put a version in front of an operator that
    // nothing on disk backs.
    return { ok: false, problem: `npm exited 0 without reporting ${CLAUDE_PACKAGE}` };
  }

  return { ok: true, result: { package: installed.name, version: installed.version } };
}

/**
 * `2.1.259 (Claude Code)`, which is the whole of what `claude --version` says.
 *
 * The version is taken as the first whitespace-delimited word and nothing is
 * assumed about the rest: the parenthesised product name is not a promise, and
 * a build that appends to it must not stop the probe from answering. What is
 * checked is that the word starts with a digit, which is the difference between
 * a version and the first word of an error message.
 */
function readClaudeVersion(completed: CompletedProcess): OneShotRead<string> {
  if (completed.exitCode !== 0) {
    return {
      ok: false,
      problem: `${CLAUDE_COMMAND} could not report its version: ${firstLine(completed.stderr) || `it exited ${completed.exitCode}`}`,
    };
  }

  const [word] = firstLine(completed.stdout).split(' ');
  if (word === undefined || !/^\d/.test(word)) {
    return {
      ok: false,
      problem: `${CLAUDE_COMMAND} printed no version: ${firstLine(completed.stdout) || 'it said nothing'}`,
    };
  }

  return { ok: true, result: word };
}

/**
 * The credentials file, read for whether it holds a credential and never for
 * what the credential is.
 *
 * The `claudeAiOauth` object is the shape 2.1.259 writes, and the presence of
 * an access token in it is the whole question. Expiry is deliberately not
 * consulted: the same object carries a refresh token and Claude Code renews
 * itself, so an expired access token means a session that refreshes, not one
 * that needs a human. Reading expiry would also mean reading a clock, and this
 * has to stay a function of its argument.
 *
 * A missing file reads as logged out, and on a host where Claude Code keeps its
 * credentials in an OS keychain instead — macOS does — that answer is wrong in
 * the safe direction. It costs a login prompt to somebody who did not need one.
 * The other direction costs a session that will not start, reported as a spawn
 * failure with nothing pointing at the cause.
 */
function readClaudeCredentials(read: FileRead): AuthState {
  if (read.kind === 'missing') return { kind: 'unauthenticated' };
  if (read.kind === 'failed') {
    return { kind: 'unknown', problem: `cannot read credentials: ${read.reason}` };
  }

  const json = parseJson(read.contents);
  if (json === undefined) {
    return { kind: 'unknown', problem: 'the credentials file is not JSON' };
  }

  const parsed = claudeCredentialsSchema.safeParse(json);
  // JSON that is not this shape is a format that changed under us, which is a
  // thing to report rather than a logout to act on: a login driven against a
  // provider that is already logged in is a needless prompt, and this is the
  // case where nobody can tell which it would be.
  if (!parsed.success) {
    return { kind: 'unknown', problem: 'the credentials file holds no recognisable credential' };
  }

  return { kind: 'authenticated' };
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
