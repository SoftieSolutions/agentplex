import { delimiter } from 'node:path';

/**
 * What a child of agentplexd gets for an environment: what this process
 * inherited, with the recorded directories put in front of its PATH.
 *
 * It is a pure function, and it is the whole of what `binPath` means. `main`
 * calls it once and hands the result to both spawn seams, so the answer to
 * "which `claude` runs" is one value composed in one place rather than a rule
 * each seam has to remember.
 *
 * Prepended, and the three options are genuinely different:
 *
 * - *Appended* would leave whatever systemd, launchd or a container image
 *   happened to supply resolving a program first, which is the ambiguity the
 *   setting exists to remove. The recorded directories are the ones setup
 *   probed; a `claude` found ahead of them is one whose version and login
 *   state nobody checked.
 * - *Replacing* removes that ambiguity and takes the rest of the machine with
 *   it. `git.status` spawns `git` and `process.start-time` spawns `ps`, both
 *   resolved from this PATH, and a coding agent shells out to `git`, `rg`,
 *   `node` and whatever else the operator's project needs. A PATH holding only
 *   `~/.agentplex/bin` is an agent that cannot use its own tools — and on a
 *   pty that failure does not even arrive as a refusal, so it would present as
 *   tools mysteriously not working inside a session.
 * - *Prepended* gives the recorded directories priority, which is the whole
 *   requirement, and leaves everything else on the machine reachable.
 *
 * What prepending does not settle is whether a provider resolved from a
 * recorded directory at all: with a `claude` further down the inherited PATH,
 * one can still be found that setup never probed. That is answered by the
 * startup preflight reporting which directory each provider actually came
 * from, where a person can read it, rather than by amputating PATH here.
 *
 * Nothing else is touched. HOME, and the provider state directory under it,
 * are how an adopted binary finds the credentials the operator logged in with.
 */

export interface ChildEnvironmentSources {
  /** `process.env` in production, a literal in a test. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** Absolute directories, searched first. Empty means inherit as before. */
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
  let inheritedPath: string | undefined;

  for (const [name, value] of Object.entries(inherited)) {
    // `process.env` is case-insensitive on Windows and a plain record is not.
    // Copying one into the other is where `Path` would survive beside the
    // `PATH` set below, leaving which of them resolves a program up to the
    // platform rather than to this list. Its value is still the inherited
    // PATH and is carried over; an exact `PATH` wins if a record holds both.
    if (name.toUpperCase() === 'PATH') {
      if (name === 'PATH' || inheritedPath === undefined) inheritedPath = value;
      continue;
    }
    environment[name] = value;
  }

  // Empty segments are dropped rather than passed through: an empty entry in a
  // PATH means the current directory, so joining a list that has one in it
  // would hand every child a cwd nobody chose.
  environment['PATH'] = [...binPath, ...(inheritedPath ?? '').split(delimiter)]
    .filter((entry) => entry.length > 0)
    .join(delimiter);

  return environment;
}
