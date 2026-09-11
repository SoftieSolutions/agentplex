import { z } from 'zod';
import { DAEMONS } from '../programs.js';
import { COMPONENTS, COMPONENT_PACKAGES, type Component } from './components.js';
import { readEnvironmentFile } from './environment-file.js';
import type { InstallationFiles } from './installation-files.js';
import {
  nodeStampFile,
  packageDirectory,
  systemLayout,
  unitFile,
  userLayout,
  type Layout,
} from './layout.js';

/**
 * What is installed on this machine, read off the disk it was installed onto.
 *
 * This is the whole subject of `agentplex status`, and the half of `start` and
 * `stop` that is not `systemctl`. The line between it and `doctor` is worth
 * stating once, here, because the two commands will otherwise grow into each
 * other:
 *
 * - **`doctor` asks whether this machine can do the work.** A pseudoterminal, a
 *   provider that is installed and logged in, a store that is mounted. It is
 *   about capability, it exits 1 when something it looked at is unusable, and
 *   it is entirely uninterested in which version of anything is installed.
 * - **`status` asks what is installed, at what version, and whether it is
 *   running.** Packages, units, runtime. It is about installation state, and it
 *   is entirely uninterested in whether a session would start.
 *
 * A machine can pass one and fail the other in both directions, which is what
 * makes them two commands: a correctly installed, running hub on a box with no
 * provider is green here and red there, and a box with every provider logged in
 * and a failed unit is the reverse.
 *
 * Nothing in this file reaches the network. That is a boundary rather than an
 * accident of what has been written so far: "a newer version than this exists"
 * is a question about a release that only a fetch can answer, and it belongs to
 * the update command along with the cache and the failure modes a fetch brings.
 * What is here is a machine describing itself, which is always available, always
 * fast, and never wrong about a registry being down.
 */

/** A prefix that does not hold an agentplex install, or that could not be read. */
export type InstallationResult =
  | { readonly ok: true; readonly installation: Installation }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface Installation {
  readonly layout: Layout;
  /**
   * `AGENTPLEX_ROLE` as the settings file records it, or `null`.
   *
   * What the machine was installed as, which is not the same as what is
   * installed on it: a role names the daemons it should run, and the packages
   * and units below are what it actually has. Reporting both is what makes a
   * half-finished install legible.
   */
  readonly role: string | null;
  readonly packages: readonly InstalledPackage[];
  /** One per unit file that is there. A unit nothing wrote is in no list. */
  readonly units: readonly InstalledUnit[];
  readonly runtime: Runtime;
}

/**
 * One component, as its installed manifest describes it.
 *
 * `absent` is an ordinary answer and not a problem: a hub machine installs no
 * server package, and reporting that as missing would make every correctly
 * installed machine in the fleet look broken. `unreadable` is the other kind --
 * a manifest that is there and is not a manifest -- and it costs itself rather
 * than the listing, exactly as an unreadable store does in `doctor`.
 */
export interface InstalledPackage {
  readonly component: Component;
  readonly name: string;
  readonly state: 'installed' | 'absent' | 'unreadable';
  readonly version: string | null;
  /**
   * `agentplex.protocol` out of the published manifest, or `null`.
   *
   * The reason this field exists at all is that four components are on four
   * release trains and are safe exactly while they agree on it. Packaging writes
   * it into every published manifest precisely so that the claim can be checked
   * on an installed machine rather than only in a workflow, and this is the
   * command that checks it. `null` is a package built before that was true, or
   * a local build -- not a disagreement, and not counted as one.
   */
  readonly protocol: number | null;
  readonly problem: string | null;
}

export interface InstalledUnit {
  /** `hub` or `server`. */
  readonly daemon: string;
  /** `agentplex-hub.service`: the same name in both scopes. */
  readonly unit: string;
  readonly file: string;
}

/**
 * The Node the daemons are started with, as far as the prefix can say.
 *
 * `install.sh` stamps the release it unpacked into `<prefix>/node`, and writes
 * nothing at all when it adopted a Node the machine already had. So a stamp is a
 * runtime this install owns and its absence is a runtime it borrowed -- which is
 * a real difference to an operator, because an upgrade replaces the first and
 * cannot touch the second. `uninstall_node` bets on the same record.
 */
export type Runtime =
  { readonly kind: 'installed'; readonly version: string } | { readonly kind: 'adopted' };

export interface InstallationLookup {
  /** `$HOME`, read at the entrypoint. The per-user layout hangs off it. */
  readonly home: string;
  /** `--prefix`, or `null` to look where an install would have put one. */
  readonly prefix: string | null;
  /** `--system`, for a machine that has a user install as well as a fleet one. */
  readonly system: boolean;
}

/**
 * The manifest as this reads it: two fields, and everything else parsed away.
 *
 * A manifest under `lib/node_modules` is a file off a disk, so it is a claim.
 * A `version` that is not a string, or an `agentplex.protocol` that is not a
 * whole positive number, is refused rather than printed -- the alternative is
 * `status` reporting `undefined` as a version, or two components "agreeing" on
 * a protocol of `NaN`.
 */
const manifestSchema = z.object({
  version: z.string().min(1),
  agentplex: z.object({ protocol: z.int().positive() }).optional(),
});

export async function readInstallation(
  lookup: InstallationLookup,
  files: InstallationFiles,
): Promise<InstallationResult> {
  const found = await findLayout(lookup, files);
  if (!found.ok) return found;

  const { layout, settings } = found;
  const packages = await Promise.all(
    COMPONENTS.map((component) => readPackage(layout, component, files)),
  );
  const units: InstalledUnit[] = [];
  for (const [daemon, unit] of Object.entries(DAEMONS)) {
    const file = unitFile(layout, unit);
    // Only what is there. A `--role=hub` machine has no server unit, and a
    // command that named one would be telling an operator to look at a file
    // nothing wrote.
    if (await files.isFile(file)) units.push({ daemon, unit, file });
  }

  return {
    ok: true,
    installation: {
      layout,
      role: settings.role,
      packages,
      units,
      runtime: await readRuntime(layout, files),
    },
  };
}

/**
 * Which of the two layouts this machine has, decided by which one's settings
 * file is there.
 *
 * The settings file is the right thing to decide on because it is the file
 * `install.sh` writes exactly once per install, in the same branch that chose
 * the unit directory and the scope. A prefix with a package in it and no
 * settings file is a half-finished install, and a directory with neither is
 * somebody's unrelated directory; both want the refusal below rather than a
 * `status` that reports emptiness as though it had looked at an agentplex.
 *
 * The user layout is tried first. On a machine that has both -- a fleet install
 * and an operator's own beside it -- the one in their home is the one they
 * meant, and `--system` is how they say otherwise.
 */
async function findLayout(
  lookup: InstallationLookup,
  files: InstallationFiles,
): Promise<
  | {
      readonly ok: true;
      readonly layout: Layout;
      readonly settings: { readonly role: string | null };
    }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const candidates = lookup.system
    ? [systemLayout(lookup.prefix ?? undefined)]
    : [
        ...(lookup.home.length === 0 && lookup.prefix === null
          ? []
          : [userLayout(lookup.home, lookup.prefix ?? undefined)]),
        systemLayout(lookup.prefix ?? undefined),
      ];

  const problems: string[] = [];
  for (const candidate of candidates) {
    const read = await files.readFile(candidate.settingsFile);
    if (read.kind === 'missing') continue;
    if (read.kind === 'failed') {
      // A file that is there and will not be read is not an absence. The fleet
      // settings file is root's, mode 0640, so this is what an operator who is
      // neither root nor the service account gets, and "no agentplex here" is
      // the one answer that would send them looking in the wrong place.
      problems.push(`cannot read ${candidate.settingsFile}: ${read.reason}`);
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

  return {
    ok: false,
    problems: [
      ...problems,
      ...(problems.length > 0
        ? []
        : [
            `no agentplex settings file at ${candidates
              .map((candidate) => candidate.settingsFile)
              .join(' or ')}: this is where install.sh writes one, and an install ` +
              'made somewhere else needs the same --prefix it was given',
          ]),
    ],
  };
}

async function readPackage(
  layout: Layout,
  component: Component,
  files: InstallationFiles,
): Promise<InstalledPackage> {
  const name = COMPONENT_PACKAGES[component];
  const absent: InstalledPackage = {
    component,
    name,
    state: 'absent',
    version: null,
    protocol: null,
    problem: null,
  };
  const read = await files.readFile(`${packageDirectory(layout, name)}/package.json`);
  if (read.kind === 'missing') return absent;
  if (read.kind === 'failed') {
    return { ...absent, state: 'unreadable', problem: read.reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.contents);
  } catch (error) {
    return { ...absent, state: 'unreadable', problem: `not JSON: ${String(error)}` };
  }
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return {
      ...absent,
      state: 'unreadable',
      problem: `not a manifest this can read: ${manifest.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  return {
    component,
    name,
    state: 'installed',
    version: manifest.data.version,
    protocol: manifest.data.agentplex?.protocol ?? null,
    problem: null,
  };
}

async function readRuntime(layout: Layout, files: InstallationFiles): Promise<Runtime> {
  const read = await files.readFile(nodeStampFile(layout));
  if (read.kind !== 'read') return { kind: 'adopted' };
  const version = (read.contents.split('\n')[0] ?? '').trim();
  return version.length === 0 ? { kind: 'adopted' } : { kind: 'installed', version };
}

/**
 * The protocols the installed components declare, and whether they are one
 * number.
 *
 * A set that disagrees is a machine whose daemons cannot talk to each other:
 * the hub and the server would connect and refuse each other's frames, and the
 * symptom is a paired machine that never comes online with nothing in either
 * log that names the cause. `install.sh` refuses to create that machine, and
 * this is what notices when one exists anyway -- a hub upgraded on its own, or
 * two installs at different times either side of a protocol change.
 *
 * A component with no declared protocol is left out rather than counted as a
 * disagreement. It is a package from before the field existed or a local build,
 * and "this one does not say" is a different and smaller fact than "these two
 * say different things".
 */
export function protocolDisagreement(
  installation: Installation,
): readonly InstalledPackage[] | null {
  const declared = installation.packages.filter(
    (one) => one.state === 'installed' && one.protocol !== null,
  );
  const protocols = new Set(declared.map((one) => one.protocol));
  return protocols.size > 1 ? declared : null;
}
