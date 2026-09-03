import { delimiter } from 'node:path';

/**
 * What a child of agentplexd gets for an environment: what this process
 * inherited, with its PATH replaced by the directories the deployment recorded.
 *
 * It is a pure function, and it is the whole of what `binPath` means. `main`
 * calls it once and hands the result to both spawn seams, so the answer to
 * "which `claude` runs" is one value composed in one place rather than a rule
 * each seam has to remember.
 *
 * Replaced, not extended. A PATH built by appending would still let whatever
 * systemd, launchd or a container image happened to supply resolve a program
 * first, which is the ambiguity the setting exists to remove: the recorded
 * directories are the ones setup probed, and a binary found outside them is a
 * binary nobody checked the version or the login state of.
 *
 * Nothing else is touched. HOME, and the provider state directory under it,
 * are how an adopted binary finds the credentials the operator logged in with.
 */

export interface ChildEnvironmentSources {
  /** `process.env` in production, a literal in a test. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** Absolute directories, in search order. Empty means inherit as before. */
  readonly binPath: readonly string[];
}

export function childEnvironment({
  inherited,
  binPath,
}: ChildEnvironmentSources): Readonly<Record<string, string | undefined>> {
  // An empty list is the deployment saying nothing about resolution, so this
  // says nothing either: a machine that has never run setup behaves exactly as
  // it did before the setting existed.
  if (binPath.length === 0) return inherited;

  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(inherited)) {
    // `process.env` is case-insensitive on Windows and a plain record is not.
    // Copying one into the other is where `Path` would survive beside the
    // `PATH` set below, leaving which of them resolves a program up to the
    // platform rather than to this list.
    if (name.toUpperCase() === 'PATH') continue;
    environment[name] = value;
  }
  environment['PATH'] = binPath.join(delimiter);

  return environment;
}
