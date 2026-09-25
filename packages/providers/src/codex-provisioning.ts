import { firstLine } from '@agentplex/node-shared';
import { CODEX_COMMAND, planCodexLaunch } from './codex-launch.js';
import { NPM_COMMAND, npmInstallSpec, parseNpmPrefix, readNpmInstall } from './npm-install.js';
import type { CompletedProcess } from './operations/process-runner.js';
import type {
  AuthProbe,
  AuthState,
  InstallPlan,
  InstallRequest,
  Launch,
  LoginRequest,
  OneShotRead,
  ProviderProvisioning,
  VersionProbe,
} from './provider-adapter.js';

/**
 * Provisioning codex: where it comes from, what version is there, whether it
 * is logged in, and how to log it in.
 *
 * Every fact in this file is a fact about codex specifically — the npm package
 * it ships as, the flag that prints its version, the subcommand that reports
 * authentication, the subcommand that signs in, and the stream each of them
 * answers on. This is the file `claude-provisioning.ts` said would exist: "a
 * second provider is this file again with different answers, rather than four
 * branches added to an installer."
 *
 * Nothing here runs anything. Each method hands back a plan, and the setup
 * registry is what turns one into a child process.
 */

/** The npm package codex ships as. */
export const CODEX_PACKAGE = '@openai/codex';

/**
 * `codex login status`, codex's own answer to "am I logged in".
 *
 * Deliberately not `<store>/auth.json`, which 0.154.0 does write and which
 * this could have read. It is an undocumented format inside a directory the
 * provider owns — on this machine it holds an `auth_mode`, a token bundle and
 * a null `OPENAI_API_KEY`, all of which are free to be restructured or moved
 * into an OS keychain in any release, at which point an adapter reading it
 * reports a perfectly logged-in store as logged out. The subcommand is
 * supported and survives its own format changes.
 *
 * There is no `--json`. It was looked for: `codex login status --help` on
 * 0.154.0 offers only the global config flags. So this one prose line is the
 * whole of the provider's answer, and `readCodexLoginStatus` is written to that
 * rather than to a shape that does not exist.
 */
const CODEX_LOGIN_STATUS_ARGS: readonly string[] = ['login', 'status'];

/**
 * `codex login --device-auth`, and not the bare `codex login`.
 *
 * Captured at the origin, and it is the one place codex made a choice the
 * Claude adapter never had to. Plain `codex login` starts a local HTTP server
 * on port 1455 and expects a browser on *that machine* to be redirected back
 * to it — codex says so itself, printing "On a remote or headless machine? Use
 * `codex login --device-auth` instead." A server agentplex drives is exactly
 * the remote headless machine that warning is about: the operator's browser is
 * somewhere else entirely and cannot reach that callback.
 *
 * `--device-auth` prints a URL and a one-time code and waits, which is the flow
 * the seam's `login` already describes — "on a headless machine that means a
 * URL opened somewhere else and a code pasted back". It costs a local operator
 * one extra paste, and it is the only one of the two that works at all in the
 * case agentplex exists for. It is undocumented in `codex login --help` on
 * 0.154.0 and was confirmed by running it.
 */
const CODEX_LOGIN_ARGS: readonly string[] = ['login', '--device-auth'];

/**
 * Five minutes for an install, for the reason Claude Code's has five: the
 * package and a platform-specific binary of it come across a network that may
 * be a home connection or a cold instance, and a bound that assumes a warm
 * cache turns a slow link into "the machine said no".
 */
const INSTALL_TIMEOUT_MS = 300_000;

/** Ten seconds for a version probe, to survive a version-manager shim. */
const VERSION_TIMEOUT_MS = 10_000;

/** Ten seconds for the authentication probe: it starts the same binary. */
const AUTH_TIMEOUT_MS = 10_000;

export function createCodexProvisioning(): ProviderProvisioning {
  return {
    install(request: InstallRequest): InstallPlan {
      const prefix = parseNpmPrefix(request.prefix);
      if (!prefix.ok) return { ok: false, problem: prefix.problem };

      const spec = npmInstallSpec(CODEX_PACKAGE, request.version);

      return {
        ok: true,
        plan: {
          // No `--no-ignore-scripts`, and its absence is the argument rather
          // than an oversight. `@openai/codex@0.154.0` declares no `scripts`
          // at all: the platform binary arrives as one of six optional
          // dependencies npm resolves for the host, so there is nothing for a
          // postinstall to do and an `--ignore-scripts` npmrc cannot leave a
          // placeholder behind. Claude Code's install is the opposite — its
          // postinstall *is* the install — and the flag is its answer, not
          // agentplex's policy. This is the case the seam predicted: a
          // provider with a different install mechanism becomes a different
          // file, not a branch in an installer nobody tests.
          //
          // `--prefix` and not a cwd, and `--json` and not the prose npm
          // prints for a person, for the reasons the Claude plan gives: the
          // first is what lets an install go through a seam with nowhere to
          // put a working directory, the second is what lets the result be
          // read rather than scraped. The package spec goes last, as one
          // element, so a version that arrived from a plan file cannot become
          // anything but a version.
          //
          // npm and not the standalone installer this machine's own codex came
          // from (`~/.codex/packages/standalone/`), for the reason the Claude
          // plan rejects `claude install`: a vendor installer is one mechanism
          // per vendor and takes no prefix, so the directory agentplex installs
          // into would stop being an argv element and start being wherever that
          // installer decides — which is the property this whole seam rests on.
          argv: {
            file: NPM_COMMAND,
            args: ['install', '--global', '--prefix', prefix.prefix, '--json', spec],
          },
          timeoutMs: INSTALL_TIMEOUT_MS,
          read: readNpmInstall(CODEX_PACKAGE),
        },
      };
    },

    version(): VersionProbe {
      return {
        argv: { file: CODEX_COMMAND, args: ['--version'] },
        timeoutMs: VERSION_TIMEOUT_MS,
        read: readCodexVersion,
      };
    },

    authState(): AuthProbe {
      return {
        argv: { file: CODEX_COMMAND, args: CODEX_LOGIN_STATUS_ARGS },
        timeoutMs: AUTH_TIMEOUT_MS,
        read: readCodexLoginStatus,
      };
    },

    login(request: LoginRequest): Launch {
      // The same launch a session gets, with different argv. That is the point
      // of sharing the builder: the login lands its credentials in this store
      // because `CODEX_HOME` is set the one way it is ever set, and it is
      // scrubbed of the nested-run markers for the same reason a session is.
      return planCodexLaunch(request.store, request.cwd, CODEX_LOGIN_ARGS);
    },
  };
}

/**
 * `codex-cli 0.154.0`, which is the whole of what `codex --version` says.
 *
 * Note the order, and that it is the opposite of Claude Code's `2.1.259
 * (Claude Code)`. The product name comes first here, so the word this reader
 * takes is the first one that *looks* like a version rather than the one in a
 * fixed position — which is also what keeps it working if a build appends a
 * commit or a channel after the number.
 */
function readCodexVersion(completed: CompletedProcess): OneShotRead<string> {
  if (completed.exitCode !== 0) {
    return {
      ok: false,
      problem: `${CODEX_COMMAND} could not report its version: ${firstLine(completed.stderr) || `it exited ${completed.exitCode}`}`,
    };
  }

  const word = firstLine(completed.stdout)
    .split(/\s+/)
    .find((candidate) => /^\d/.test(candidate));

  if (word === undefined) {
    return {
      ok: false,
      problem: `${CODEX_COMMAND} printed no version: ${firstLine(completed.stdout) || 'it said nothing'}`,
    };
  }

  return { ok: true, result: word };
}

/** What codex says when it is logged in, whichever way it is logged in. */
const LOGGED_IN_PREFIX = 'Logged in';

/** What codex says when it is not. Checked first: it contains the words above. */
const LOGGED_OUT_LINE = 'Not logged in';

/**
 * Whether codex says this store is logged in.
 *
 * Read off **stderr**, which is the thing that had to be captured rather than
 * assumed: 0.154.0 prints nothing at all on stdout for this subcommand, in
 * both directions. A reader that looked where every other probe in this
 * package looks would find an empty string and report that codex could not
 * answer, for a codex that answered.
 *
 * The text is read *before* the exit code, for the reason
 * `readClaudeAuthStatus` reads its JSON first: logged out is an answer codex
 * gives and a status it reports as failure at the same time, exiting 1 while
 * printing `Not logged in`. A reader that refused on a nonzero exit — which is
 * the obvious way to write this — would turn every logged-out store into "the
 * probe could not run" and lose the one fact setup exists to act on.
 *
 * The match is a prefix, not a sentence. 0.154.0 carries six spellings of
 * being logged in — ChatGPT, an API key, an access token, a personal access
 * token, workload identity, and two Amazon Bedrock variants — and what they
 * have in common is the first two words. The logged-out line is tested first
 * because it contains those words too, in the middle.
 *
 * And it is every line rather than the first, which is the part that had to be
 * learned by running it inside the product. Driving `agentplex setup` end to
 * end against a codex it had just installed, the probe came back with this on
 * stderr:
 *
 *     WARNING: proceeding, even though we could not create PATH aliases:
 *     Refusing to create helper binaries under temporary dir "/var/.../T/"
 *     Not logged in
 *
 * — and a reader taking `stderr`'s first line reported "codex did not report
 * its authentication state" for a codex that had reported it perfectly well on
 * the next line. Warnings on the way to an answer are a thing programs do, and
 * the answer is what was asked for, so the answer is what is looked for.
 */
function readCodexLoginStatus(completed: CompletedProcess): OneShotRead<AuthState> {
  for (const line of answerLines(completed)) {
    if (line === LOGGED_OUT_LINE) return { ok: true, result: 'unauthenticated' };
    if (line.startsWith(LOGGED_IN_PREFIX)) return { ok: true, result: 'authenticated' };
  }

  // Nothing that answers the question. Not a logout: a `codex` that is not
  // there, a wrapper in front of it, or a release that stopped printing this
  // are different facts, and reporting them as "logged out" would send an
  // operator through a login that fails for the reason nobody named.
  //
  // What is quoted back is the *last* line rather than the first, because a
  // program that printed a warning and then failed says why it failed at the
  // end. An operator shown the warning instead is shown the thing that did not
  // matter.
  const said = lastLine(completed.stderr) || lastLine(completed.stdout);
  return {
    ok: false,
    problem: `${CODEX_COMMAND} did not report its authentication state: ${said || `it exited ${completed.exitCode}`}`,
  };
}

/** Every non-empty line the probe printed, stderr first: that is where it answers. */
function answerLines(completed: CompletedProcess): readonly string[] {
  return [completed.stderr, completed.stdout]
    .flatMap((stream) => stream.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}
