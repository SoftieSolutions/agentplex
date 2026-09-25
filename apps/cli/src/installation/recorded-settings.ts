import { readEnvironmentFile, type RecordedSettings } from './environment-file.js';
import type { InstallationFiles } from './installation-files.js';
import { systemLayout, userLayout, type Layout, type UnitScope } from './layout.js';

/**
 * Finding the settings file an install wrote, which `status`, `start`, `stop`
 * and `update` do through `readInstallation` and `doctor` does on its own.
 *
 * Its own module, apart from `installation.ts`, because of what the doctor may
 * reach. `installation.ts` names the daemons' units out of `programs.ts`, and
 * that table reaches every command -- setup among them, which opens a
 * pseudoterminal. The doctor promises it cannot, and `pty-boundary.test.ts`
 * holds it to that by walking every module it can reach; the settings file is
 * not worth breaking the promise for, so the search lives here and both sides
 * import it.
 */

export interface InstallationLookup {
  /** `$HOME`, read at the entrypoint. The per-user layout hangs off it. */
  readonly home: string;
  /** `--prefix`, or `null` to look where an install would have put one. */
  readonly prefix: string | null;
  /** `--system`, for a machine that has a user install as well as a fleet one. */
  readonly system: boolean;
}

/** What a settings file says about the deployment, as `doctor` reads it. */
export interface RecordedDeployment {
  /** The tier whose settings file this is, or `null` when none was found. */
  readonly scope: UnitScope | null;
  /** The settings file found, read or not, or `null` when there is none. */
  readonly file: string | null;
  /** Every value the file holds; empty when it was not found or not read. */
  readonly values: ReadonlyMap<string, string>;
  /** Why the file could not be read, when it could not. */
  readonly problems: readonly string[];
}

/**
 * The settings file as `doctor` reads it: every value in it, the tier it was
 * found on, and never a refusal.
 *
 * The same search `status` makes, because the doctor's question is about the
 * deployment the daemons are started with and that is the file their units
 * name. What differs is what each command can do without it. `status` has
 * nothing to report on a machine with no settings file; `doctor` still has the
 * environment and its flags, which is how a container or a checkout is
 * configured at all. So a missing file is an empty map, and one that is there
 * and will not be read -- the fleet file is root's at 0640, so this is the
 * ordinary case for an operator who is neither root nor the account -- is a
 * problem to report beside the findings rather than instead of them.
 *
 * The scope comes back with it, and for an unreadable file too, because it is
 * what decides the home a daemon defaults its paths from: on the fleet tier
 * that is the service account's, whatever the operator's is.
 */
export async function readRecordedSettings(
  lookup: InstallationLookup,
  files: InstallationFiles,
): Promise<RecordedDeployment> {
  const found = await findLayout(lookup, files);
  if (found.ok) {
    return {
      scope: found.layout.scope,
      file: found.layout.settingsFile,
      values: found.settings.values,
      problems: [],
    };
  }

  const [first] = found.unreadable;
  return {
    scope: first?.layout.scope ?? null,
    file: first?.layout.settingsFile ?? null,
    values: new Map(),
    problems: found.unreadable.map(unreadableProblem),
  };
}

export interface UnreadableSettings {
  readonly layout: Layout;
  readonly reason: string;
}

export function unreadableProblem({ layout, reason }: UnreadableSettings): string {
  return `cannot read ${layout.settingsFile}: ${reason}`;
}

/**
 * Which of the two layouts this machine has, decided by which one's settings
 * file is there.
 *
 * The settings file is the right thing to decide on because it is the file
 * `install.sh` writes exactly once per install, in the same branch that chose
 * the unit directory and the scope. A prefix with a package in it and no
 * settings file is a half-finished install, and a directory with neither is
 * somebody's unrelated directory; both want the refusal `readInstallation`
 * makes rather than a `status` that reports emptiness as though it had looked
 * at an agentplex.
 *
 * The user layout is tried first. On a machine that has both -- a fleet install
 * and an operator's own beside it -- the one in their home is the one they
 * meant, and `--system` is how they say otherwise.
 */
export async function findLayout(
  lookup: InstallationLookup,
  files: InstallationFiles,
): Promise<
  | {
      readonly ok: true;
      readonly layout: Layout;
      readonly settings: RecordedSettings;
    }
  | {
      readonly ok: false;
      readonly candidates: readonly Layout[];
      readonly unreadable: readonly UnreadableSettings[];
    }
> {
  const candidates = lookup.system
    ? [systemLayout(lookup.prefix ?? undefined)]
    : [
        ...(lookup.home.length === 0 && lookup.prefix === null
          ? []
          : [userLayout(lookup.home, lookup.prefix ?? undefined)]),
        systemLayout(lookup.prefix ?? undefined),
      ];

  const unreadable: UnreadableSettings[] = [];
  for (const candidate of candidates) {
    const read = await files.readFile(candidate.settingsFile);
    if (read.kind === 'missing') continue;
    if (read.kind === 'failed') {
      // A file that is there and will not be read is not an absence. The fleet
      // settings file is root's, mode 0640, so this is what an operator who is
      // neither root nor the service account gets, and "no agentplex here" is
      // the one answer that would send them looking in the wrong place.
      unreadable.push({ layout: candidate, reason: read.reason });
      continue;
    }

    const settings = readEnvironmentFile(read.contents);
    // Only the fleet layout takes its prefix from the file, and only because
    // its settings file is not inside the prefix: `/etc/agentplex/agentplex.env`
    // says nothing about where the install went, which is the whole reason
    // `install.sh` records the line. In the per-user layout the file was found
    // *inside* the prefix, so finding it is already knowing where it is -- and
    // a `--prefix` somebody typed wins over a recorded one either way, because
    // a flag is typed by a person at the moment they mean it.
    const recorded =
      candidate.scope === 'system' && lookup.prefix === null && settings.prefix !== null
        ? systemLayout(settings.prefix)
        : candidate;
    return { ok: true, layout: recorded, settings };
  }

  return { ok: false, candidates, unreadable };
}
