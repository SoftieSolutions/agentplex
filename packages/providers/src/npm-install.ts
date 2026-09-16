import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { CompletedProcess } from './operations/process-runner.js';
import type { InstalledProvider, OneShotRead } from './provider-adapter.js';

/**
 * npm, as an install mechanism rather than as one provider's install.
 *
 * `provider-adapter.ts` predicts that a second provider is a provisioning file
 * again with different answers, and it was right about everything that is
 * actually per-provider: which package, which prefix, which flags that
 * package's own postinstall needs, what a successful install then has to
 * verify. It was not describing npm. The two files ended up invoking the same
 * program the same way and parsing the same report twice, which is this file.
 *
 * What lives here is what is true of npm and of nothing else: how a package
 * spec is spelled, what makes a `--prefix` an argv element rather than a
 * question, and what `npm install --json` says back. What does not live here is
 * the argv itself. Each provisioning file still builds its own, because the
 * flags on it are that provider's answer to that provider's question --
 * `--no-ignore-scripts` is Claude Code's postinstall and not agentplex policy
 * -- and a shared builder taking a list of flags would put those answers behind
 * a parameter where nobody reading the provider's file can see them.
 *
 * Nothing here runs anything: it hands back pieces of a plan, and the setup
 * registry is what turns one into a child process.
 */

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
 * The package to install, as the single argv element npm reads it from.
 *
 * One element, and last on the argv, so a version that arrived from a plan file
 * cannot become anything but a version.
 */
export function npmInstallSpec(packageName: string, version: string | null): string {
  return `${packageName}@${version ?? NPM_LATEST_TAG}`;
}

/** A prefix an install argv can be built out of, or the reason there is not one. */
export type NpmPrefix =
  { readonly ok: true; readonly prefix: string } | { readonly ok: false; readonly problem: string };

/**
 * A prefix an install will build an argv out of.
 *
 * Absolute, because a relative prefix resolves against whatever directory the
 * setup process happens to have been started in — the exact ambiguity the
 * absence of a cwd on the process seam exists to remove — and because an
 * absolute path cannot be mistaken by npm for one of its own options. No NUL,
 * because a NUL truncates the path at the syscall, so what is written to is a
 * prefix of what was checked.
 */
export function parseNpmPrefix(prefix: string): NpmPrefix {
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
 * Two fields out of the twelve npm prints, and a passthrough for the rest:
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

/**
 * How to read what `npm install --global --prefix <dir> --json <pkg>@<version>`
 * printed, for one named package.
 *
 * The package name is the whole of what the two callers differ by, so it is the
 * whole of the parameter list. A reader is built once per plan and handed
 * straight to `OneShotPlan.read`.
 */
export function readNpmInstall(
  packageName: string,
): (completed: CompletedProcess) => OneShotRead<InstalledProvider> {
  return (completed) => {
    const json = parseJson(completed.stdout);
    if (json === undefined) {
      // npm printed something that is not the format it was asked for.
      // Reporting the exit code alone would hide a wrapper — a corporate npm
      // shim, a proxy login page — that is the actual thing an operator has to
      // deal with.
      return {
        ok: false,
        problem: `npm printed no JSON: ${firstLine(completed.stdout) || firstLine(completed.stderr)}`,
      };
    }

    if (completed.exitCode !== 0) {
      // npm's own words. "No matching version found for @anthropic-ai/claude-
      // code@0.0.0" tells an operator what to change; "npm exited 1" does not.
      // The same is true of the npmrc that refuses an install outright:
      // ESTRICTALLOWSCRIPTS arrives here with npm's three ways to proceed in
      // its summary, and passing that through verbatim is a better outcome than
      // agentplex deciding on an operator's behalf that their hardening does
      // not apply to it.
      const failure = npmErrorSchema.safeParse(json);
      return {
        ok: false,
        problem: failure.success
          ? `npm could not install ${packageName}: ${failure.data.error.summary}`
          : `npm could not install ${packageName}: it exited ${completed.exitCode}`,
      };
    }

    const parsed = npmInstallSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, problem: 'npm printed JSON that is not an install report' };
    }

    const added = parsed.data.add ?? [];
    const changed = (parsed.data.change ?? []).map((change) => change.to);
    // By name, and not "the first entry": npm reports the platform package —
    // `@openai/codex-darwin-arm64`, at a version spelled `0.154.0-darwin-arm64`
    // — right beside the one that was asked for, and an operator shown that
    // version would be shown something no release is called.
    const installed = [...added, ...changed].find((entry) => entry.name === packageName);

    if (installed === undefined) {
      // npm exited 0 having done something that did not include this package.
      // Saying it was installed would put a version in front of an operator
      // that nothing on disk backs.
      return { ok: false, problem: `npm exited 0 without reporting ${packageName}` };
    }

    return { ok: true, result: { package: installed.name, version: installed.version } };
  };
}

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
