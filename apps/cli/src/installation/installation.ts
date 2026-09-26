import type { ProtocolLeg } from '@agentplex/protocol';
import { releaseProtocolSchema, type ReleaseProtocol } from '@agentplex/release';
import { z } from 'zod';
import { DAEMONS } from '../programs.js';
import { COMPONENTS, COMPONENT_PACKAGES, type Component } from './components.js';
import type { InstallationFiles } from './installation-files.js';
import { nodeStampFile, packageDirectory, unitFile, type Layout } from './layout.js';
import { findLayout, unreadableProblem, type InstallationLookup } from './recorded-settings.js';

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
   * `agentplex.protocol` out of the published manifest -- the protocol legs this
   * package speaks, each at its version -- or `null`.
   *
   * The reason this field exists at all is that four components are on four
   * release trains and are safe exactly while the ones that speak a leg agree
   * on it. Packaging writes it into every published manifest precisely so that
   * the claim can be checked on an installed machine rather than only in a
   * workflow, and this is the command that checks it. The CLI's is `{}`, the
   * server's names only the server leg. `null` is a manifest with no
   * `agentplex` field at all -- not a disagreement, and not counted as one.
   */
  readonly protocol: ReleaseProtocol | null;
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

/**
 * The manifest as this reads it: two fields, and everything else parsed away.
 *
 * A manifest under `lib/node_modules` is a file off a disk, so it is a claim.
 * A `version` that is not a string, or an `agentplex.protocol` that is not an
 * object of whole positive client and server legs, is refused rather than
 * printed -- the alternative is `status` reporting `undefined` as a version, or
 * two components "agreeing" on a protocol of `NaN`. The same schema
 * `versions.json` releases are held to, from the package that owns it, so a
 * manifest this accepts is one a release could have described. A bare number is
 * refused with the rest: nothing was ever published with one.
 */
const manifestSchema = z.object({
  version: z.string().min(1),
  agentplex: z.object({ protocol: releaseProtocolSchema }).optional(),
});

export async function readInstallation(
  lookup: InstallationLookup,
  files: InstallationFiles,
): Promise<InstallationResult> {
  const found = await findLayout(lookup, files);
  if (!found.ok) {
    return {
      ok: false,
      problems:
        found.unreadable.length > 0
          ? found.unreadable.map(unreadableProblem)
          : [
              `no agentplex settings file at ${found.candidates
                .map((candidate) => candidate.settingsFile)
                .join(' or ')}: this is where install.sh writes one, and an install ` +
                'made somewhere else needs the same --prefix it was given',
            ],
    };
  }

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

/** The legs a disagreement is asked about, in the order it is reported. */
const PROTOCOL_LEGS: readonly ProtocolLeg[] = ['client', 'server'];

/**
 * The legs a package speaks, as `status` and `update` print them:
 * `client 40 server 39`, `server 39`, or nothing at all for the CLI, which
 * speaks neither.
 */
export function protocolWords(protocol: ReleaseProtocol | null): string {
  if (protocol === null) return '';
  return PROTOCOL_LEGS.flatMap((leg) => {
    const version = protocol[leg];
    return version === undefined ? [] : [`${leg} ${String(version)}`];
  }).join(' ');
}

/** One protocol leg the components do not agree on, and every one that declared it. */
export interface ProtocolDisagreement<T> {
  readonly leg: ProtocolLeg;
  readonly declared: readonly T[];
}

/**
 * The legs a set of components disagree on, each with the components that
 * declared it, or `null` when every leg agrees.
 *
 * Asked leg by leg, of the components that declare that leg, and never across
 * legs: a hub at client 4 and server 3 beside a server at 3 is the machine a
 * client-only change leaves, and it is the reason there are two legs. A
 * component that does not speak a leg -- the CLI speaks neither, the server no
 * client -- is not asked about it, and one with no declared protocol at all is
 * left out of every leg.
 *
 * Generic over what is being compared, because `status` asks it of what is
 * installed and `update` of what would be installed afterwards, and two copies
 * of this rule are two ways to disagree about what a disagreement is.
 */
export function legDisagreements<T>(
  components: readonly T[],
  protocolOf: (component: T) => ReleaseProtocol | null,
): readonly ProtocolDisagreement<T>[] | null {
  const disagreements = PROTOCOL_LEGS.flatMap((leg) => {
    const declared = components.filter((one) => protocolOf(one)?.[leg] !== undefined);
    const versions = new Set(declared.map((one) => protocolOf(one)?.[leg]));
    return versions.size > 1 ? [{ leg, declared }] : [];
  });
  return disagreements.length > 0 ? disagreements : null;
}

/**
 * The protocol legs the installed components declare, and whether each is one
 * number.
 *
 * A leg that disagrees is a pair of processes that cannot talk: on the server
 * leg the hub and the server connect and refuse each other at the handshake, so
 * a paired machine never comes online; on the client leg every browser is
 * refused at hello. `install.sh` refuses to create either machine, and this is
 * what notices when one exists anyway -- a hub upgraded on its own, or two
 * installs at different times either side of a change to a leg.
 *
 * A component with no declared protocol is left out rather than counted as a
 * disagreement. "This one does not say" is a different and smaller fact than
 * "these two say different things".
 */
export function protocolDisagreement(
  installation: Installation,
): readonly ProtocolDisagreement<InstalledPackage>[] | null {
  return legDisagreements(
    installation.packages.filter((one) => one.state === 'installed'),
    (one) => one.protocol,
  );
}
