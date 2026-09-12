import { delimiter } from 'node:path';

/**
 * What a child of agentplex gets for an environment: what this process
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
 * `TZ` is the second thing composed here, and it is here rather than at a spawn
 * site for the reason PATH is. A server under systemd inherits whatever its
 * unit was started with, which on a container image is UTC, and the agents it
 * spawns inherit that in turn: asked what day it is, one answers in a zone
 * nobody chose, and the operator sitting in front of the machine is somewhere
 * else. That is one answer the deployment gives, and every child has to get
 * the same one -- a session's pty and the probe of the binary that session
 * runs are two seams, and a setting read at each of them is a setting that can
 * end up meaning two things on one machine.
 *
 * Unset inherits, exactly as an empty `binPath` does: a deployment that says
 * nothing gets what it had, and no already-installed machine changes because
 * this exists.
 *
 * `LANG` and `LC_ALL` are the obvious next two and are deliberately not here,
 * because they are not the same kind of question. A zone is something only the
 * deployment knows -- no image can work out where its operator is, so somebody
 * has to say. A locale is a property of the image: which locales were
 * generated in it decides what `LANG` may be, and a server that set
 * `LANG=en_US.UTF-8` on an image carrying only `C.UTF-8` would hand its
 * children a value that quietly does nothing. Checking that is a question to
 * ask the machine rather than a word to parse, and a setting whose wrong value
 * nothing can refuse is exactly the failure the zone's parser exists to
 * prevent. If it is ever wanted it arrives as another input to this function,
 * composed the same way, and not as a second place that reaches for an
 * environment.
 *
 * Nothing else is touched. HOME, and the provider state directory under it,
 * are how an adopted binary finds the credentials the operator logged in with.
 */

export interface ChildEnvironmentSources {
  /** `process.env` in production, a literal in a test. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** Absolute directories, searched first. Empty means inherit as before. */
  readonly binPath: readonly string[];
  /**
   * The zone a child reports times in, as the tz database spells it.
   * Undefined means inherit.
   *
   * Required rather than optional, so that every spawn seam in this repository
   * states which answer it takes. A seam that inherits says so.
   */
  readonly timezone: string | undefined;
}

export function childEnvironment({
  inherited,
  binPath,
  timezone,
}: ChildEnvironmentSources): Readonly<Record<string, string | undefined>> {
  // Nothing configured is the deployment saying nothing, so this says nothing
  // either: a machine that has never run setup behaves exactly as it did
  // before either setting existed.
  if (binPath.length === 0 && timezone === undefined) return inherited;

  const environment: Record<string, string | undefined> = {};
  const resolvesPath = binPath.length > 0;
  let inheritedPath: string | undefined;

  for (const [name, value] of Object.entries(inherited)) {
    // `process.env` is case-insensitive on Windows and a plain record is not.
    // Copying one into the other is where `Path` would survive beside the
    // `PATH` set below, leaving which of them resolves a program up to the
    // platform rather than to this list. Its value is still the inherited
    // PATH and is carried over; an exact `PATH` wins if a record holds both.
    if (resolvesPath && name.toUpperCase() === 'PATH') {
      if (name === 'PATH' || inheritedPath === undefined) inheritedPath = value;
      continue;
    }
    // The same hazard, and this one is dropped rather than carried over: the
    // inherited zone is the one being replaced.
    if (timezone !== undefined && name.toUpperCase() === 'TZ') continue;
    environment[name] = value;
  }

  // Only what was configured is rebuilt. A deployment that chose a zone and no
  // directories keeps the PATH it inherited character for character, rather
  // than one this function reassembled out of itself.
  if (resolvesPath) {
    // Empty segments are dropped rather than passed through: an empty entry in
    // a PATH means the current directory, so joining a list that has one in it
    // would hand every child a cwd nobody chose.
    environment['PATH'] = [...binPath, ...(inheritedPath ?? '').split(delimiter)]
      .filter((entry) => entry.length > 0)
      .join(delimiter);
  }

  if (timezone !== undefined) environment['TZ'] = timezone;

  return environment;
}

/**
 * The directories a child of this process will search, in order.
 *
 * The inverse of the function above, and deliberately derived from its output
 * rather than from `binPath`: the question the preflight asks is "where will a
 * bare program name actually resolve", and the only honest answer is the one
 * the child's own PATH gives. Reading `binPath` instead would report the
 * configured directories and miss the `claude` further down the inherited PATH
 * that a spawn would find when none of them holds one -- which is precisely the
 * case `childEnvironment` says prepending leaves open, and precisely the case
 * "which directory did this come from" exists to answer.
 *
 * Empty segments are dropped for the reason they are dropped there: an empty
 * PATH entry means the current directory, and a preflight that reported a
 * provider as resolving from wherever the process was started would be reading
 * an ambiguity as a fact.
 */
export function childSearchPath(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return (environment['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0);
}
