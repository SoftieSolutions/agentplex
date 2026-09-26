import {
  isReleaseVersion,
  newestInSeries,
  type ReleaseProtocol,
  type VersionsManifest,
} from '@agentplex/release';
import {
  COMPONENT_PACKAGES,
  RELEASE_DOWNLOAD_URL,
  releaseUrl,
  type Component,
} from '../../installation/components.js';
import { legDisagreements } from '../../installation/installation.js';
import { tarballLocation, type PackageTarball } from '../../installation/package-install.js';
import {
  NODE_DIRECTORY,
  PACKAGE_DIRECTORY,
  SYSTEM_ACCOUNT,
  binDirectory,
  stateDirectory,
  unitFile,
  type Layout,
} from '../../installation/layout.js';
import { unitFileName } from '../../installation/unit-file.js';
import { VERSIONS_URL } from '../../versions/version-check.js';
import type { InstallRequest } from './install-flags.js';

/**
 * What an install would do, after the runtime: `install.sh`'s dry run for
 * everything the bin is to take over.
 *
 * Pure. Every fact about the machine -- the manifest, the tarball directory's
 * listing, which files are already there, whether there is a systemd -- is
 * read by the command and handed in as a value, so each case below is a
 * literal in a test.
 *
 * The labels and the sentences are the script's `report` and `die` lines,
 * copied rather than improved. The handover that moves the install onto this
 * command moves `install.sh.integration.test.ts`'s `planned()` assertions over
 * with it, and a reworded line would be an assertion rewritten rather than
 * moved. The labels that outgrow `report`'s pad -- `client protocol`, `server
 * protocol` -- overflow it here exactly as `printf '%-10s %s'` lets them.
 *
 * The manifest rules are the script's too, and not `update`'s: a dry run reads
 * the manifest only from a local file, an exact pin answers without one and a
 * series does not, and `AGENTPLEX_PACKAGE` means local tarballs with no version
 * resolved and no protocol checked.
 *
 * The `package` line is master's `install_package` line. AGX-324 rewrites that
 * function and adds a `method` line after it; AGX-329, which hands the install
 * over, reconciles the two.
 */

/** Where the packages come from, as the command found it. */
export type ReleaseInput =
  /** `AGENTPLEX_PACKAGE`: the directory, and its entries, or `null` when it is not a directory. */
  | {
      readonly kind: 'tarballs';
      readonly directory: string;
      readonly entries: readonly string[] | null;
    }
  /** A manifest read from a file, and the path it was read from. */
  | { readonly kind: 'manifest'; readonly source: string; readonly manifest: VersionsManifest }
  /** A dry run with no local manifest: the network one is a download, and none is made. */
  | { readonly kind: 'unread' };

export interface InstallPlanInput {
  readonly request: InstallRequest;
  readonly layout: Layout;
  readonly release: ReleaseInput;
  /** Whether the settings file is already there, to be left alone. */
  readonly settingsPresent: boolean;
  /** The unit files that are already there, by path. */
  readonly unitsPresent: readonly string[];
  /** Why this machine can hold no unit, or `null` when it can. */
  readonly unitSkipReason: string | null;
}

/** One line of the plan: `report <label> <text>`. */
export interface PlanLine {
  readonly label: string;
  readonly text: string;
}

/** One package the install would put in the prefix, and the version it is, when that is known. */
export interface PlannedPackage extends PackageTarball {
  /**
   * The release it is: resolved from the manifest, or read off the name npm
   * packed a local tarball under. `null` when the name carries no version.
   */
  readonly version: string | null;
}

export type InstallPlan =
  | {
      readonly ok: true;
      readonly lines: readonly PlanLine[];
      /**
       * What would be installed, in the role's order, or `null` when a dry run
       * left a version unresolved and so could not say.
       */
      readonly packages: readonly PlannedPackage[] | null;
    }
  | { readonly ok: false; readonly problem: string };

/** `report()`: `printf '%-10s %s\n'`, without the newline. */
export function formatPlanLine(line: PlanLine): string {
  return `${line.label.padEnd(10)} ${line.text}`;
}

/**
 * `resolve_unit_support`: a reason rather than a yes or a no, because the two
 * reasons send an operator to different places.
 */
export function unitSkipReason(platform: string, hasSystemctl: boolean): string | null {
  if (platform !== 'linux') return 'macOS has no systemd, hand the process to launchd';
  if (!hasSystemctl) return 'no systemctl on this machine';
  return null;
}

class Stop extends Error {}

export function planInstall(input: InstallPlanInput): InstallPlan {
  try {
    const release = releasePlan(input);
    return {
      ok: true,
      lines: [...release.lines, ...ownershipLines(input), settingsLine(input), ...unitLines(input)],
      packages: release.packages,
    };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.message };
    throw error;
  }
}

/** What one component resolved to: a version, and the legs it records. */
interface Resolved {
  readonly component: Component;
  readonly version: string | null;
  readonly protocol: ReleaseProtocol | null;
}

/** `resolve_release`, `report_release` and the `package` line of `install_package`. */
function releasePlan({ request, layout, release }: InstallPlanInput): {
  readonly lines: readonly PlanLine[];
  readonly packages: readonly PlannedPackage[] | null;
} {
  const into = ` into ${layout.prefix}`;

  if (release.kind === 'tarballs') {
    const tarballs = request.components.map((component): PlannedPackage => {
      const name = COMPONENT_PACKAGES[component];
      const found = packageTarball(release, name, request.role);
      return {
        component,
        package: name,
        version: found.version,
        source: { kind: 'file', path: found.path },
      };
    });
    return {
      lines: [
        {
          label: 'release',
          text:
            `the tarballs in ${release.directory}; no version is resolved and no protocol is ` +
            'checked, because a directory of tarballs is one build and not a release',
        },
        {
          label: 'package',
          text: `${tarballs.map((one) => tarballLocation(one.source)).join(' ')}${into}`,
        },
      ],
      packages: tarballs,
    };
  }

  const resolved = request.components.map((component) =>
    resolveComponent(component, request.pins[component] ?? null, release),
  );
  checkProtocolAgreement(resolved);

  const source = release.kind === 'manifest' ? release.source : null;
  const versions = resolved
    .map((one) => `${one.component} ${one.version ?? '(not resolved)'}`)
    .join(', ');
  const packages = resolved.every((one) => one.version !== null)
    ? resolved.map((one): PlannedPackage => ({
        component: one.component,
        package: COMPONENT_PACKAGES[one.component],
        version: one.version,
        source: { kind: 'download', url: releaseUrl(one.component, one.version ?? '') },
      }))
    : null;
  const specs =
    packages === null ? null : packages.map((one) => tarballLocation(one.source)).join(' ');

  const lines: readonly PlanLine[] = [
    {
      label: 'release',
      text:
        source === null
          ? `${versions}: a dry run downloads nothing, and ${VERSIONS_URL} is a download`
          : `${versions} (from ${source})`,
    },
    legLine('client', resolved, source),
    legLine('server', resolved, source),
    {
      label: 'package',
      text:
        specs === null
          ? `${request.components.join(' ')} from ${RELEASE_DOWNLOAD_URL}${into}, at whatever ` +
            'versions the line above resolves to'
          : `${specs}${into}`,
    },
  ];
  return { lines, packages };
}

/**
 * `resolve_component_versions` for one component: `read_pinned_release` when it
 * is pinned and `read_versions_entry` when it is not.
 *
 * With no manifest read, an exact pin is still an answer -- it names the tag
 * outright and only its protocol went unread -- and a series is not, because
 * resolving one is exactly what needed the file.
 */
function resolveComponent(
  component: Component,
  pin: InstallRequest['pins'][Component] | null,
  release: Exclude<ReleaseInput, { kind: 'tarballs' }>,
): Resolved {
  if (release.kind === 'unread') {
    return { component, version: pin?.kind === 'exact' ? pin.version : null, protocol: null };
  }

  const { source, manifest } = release;
  const entry = manifest[component];
  if (entry === undefined) {
    throw new Stop(
      `${source} names no ${component}, and this machine installs one. It is the manifest of ` +
        'every release of every component, so a missing entry is a release that did not finish ' +
        'rather than something to guess at',
    );
  }

  let version = entry.current;
  if (pin?.kind === 'exact') version = pin.version;
  if (pin?.kind === 'series') {
    const newest = newestInSeries(Object.keys(entry.releases), pin.series);
    if (newest === null) {
      throw new Stop(
        `${source} offers no ${component} release under ${pin.series}, so ` +
          `${component}@${pin.series} names a series it advertises nothing in. A series takes ` +
          'the newest release under it and never a prerelease; a prerelease named exactly is ' +
          'installed',
      );
    }
    version = newest;
  }

  const protocol = entry.releases[version];
  if (protocol === undefined) {
    throw new Stop(
      `${source} offers no ${component} release at ${version}, so there is nothing here to ` +
        `install ${component}-v${version} from. This file is the set of releases it advertises ` +
        'and not the set of tags that exist: a 2.x release is advertised from its own branch, ' +
        'and a mirror holds whatever was copied into it',
    );
  }
  return { component, version, protocol };
}

/**
 * `check_protocol_agreement`, through the one rule `status` and `update` use.
 * The first leg that disagrees stops the run, naming the first component that
 * recorded it and the first that recorded something else, as the script does.
 */
function checkProtocolAgreement(resolved: readonly Resolved[]): void {
  const disagreement = legDisagreements(resolved, (one) => one.protocol)?.[0];
  if (disagreement === undefined) return;

  const { leg, declared } = disagreement;
  const [first] = declared;
  const other = declared.find((one) => one.protocol?.[leg] !== first?.protocol?.[leg]);
  if (first === undefined || other === undefined) return;
  throw new Stop(
    `this machine would install a ${first.component} speaking ${leg} protocol ` +
      `${String(first.protocol?.[leg])} and a ${other.component} speaking ${leg} protocol ` +
      `${String(other.protocol?.[leg])}, and two components that disagree about the ${leg} ` +
      'protocol do not talk to each other. A change to a leg releases every component that ' +
      'records it together, so this is a broken release rather than a choice to make: nothing ' +
      'has been installed',
  );
}

/** `report_leg`: the number, and which of the components installed here agree on it. */
function legLine(
  leg: 'client' | 'server',
  resolved: readonly Resolved[],
  source: string | null,
): PlanLine {
  const label = `${leg} protocol`;
  if (source === null) {
    return {
      label,
      text:
        'not checked: a dry run downloads nothing, and the file that says what a release ' +
        'speaks is a download',
    };
  }

  const speakers = resolved.filter((one) => one.protocol?.[leg] !== undefined);
  const [first] = speakers;
  const last = speakers[speakers.length - 1];
  if (first === undefined || last === undefined) {
    return { label, text: 'not spoken by anything this machine installs' };
  }
  const protocol = String(first.protocol?.[leg]);
  if (speakers.length === 1)
    return { label, text: `${protocol}, which ${last.component} agrees on` };
  const rest = speakers
    .slice(0, -1)
    .map((one) => one.component)
    .join(', ');
  return { label, text: `${protocol}, which ${rest} and ${last.component} agree on` };
}

/**
 * `package_tarball`: the one tarball in the directory holding one package.
 *
 * npm names a pack after the package with the scope flattened, then
 * `-<version>.tgz`, and the digit after the name is what keeps the command's
 * own `softiesolutions-agentplex-` from matching the hub's, the server's and the
 * client's as well. Taken in the order a glob lists them, and a directory entry
 * whose name starts with a dot is not one a glob lists.
 */
function packageTarball(
  release: Extract<ReleaseInput, { kind: 'tarballs' }>,
  name: string,
  role: string,
): { readonly path: string; readonly version: string | null } {
  const { directory, entries } = release;
  if (entries === null) {
    throw new Stop(
      `AGENTPLEX_PACKAGE names "${directory}", which is not a directory: it is the directory ` +
        'holding the packed tarballs to install, one per package',
    );
  }
  const flat = name.replace(/^@/, '').replaceAll('/', '-');
  const found = [...entries]
    .sort()
    .find(
      (entry) =>
        !entry.startsWith('.') &&
        entry.endsWith('.tgz') &&
        entry.startsWith(`${flat}-`) &&
        /^[0-9]/.test(entry.slice(flat.length + 1)),
    );
  if (found === undefined) {
    throw new Stop(
      `no ${flat}-<version>.tgz in ${directory}, and --role=${role} installs ${name}. A ` +
        'directory missing one of the packages a role needs would install the rest and quietly ' +
        'leave that one to a registry',
    );
  }
  // The version is the name's, read as a release version or not at all: a
  // local build names itself `0.0.0`, and anything the grammar refuses is a
  // name that says nothing about what is inside.
  const version = found.slice(flat.length + 1, -'.tgz'.length);
  return { path: `${directory}/${found}`, version: isReleaseVersion(version) ? version : null };
}

/** `grant_service_account_ownership`'s line, under `--system` only. */
function ownershipLines({ layout }: InstallPlanInput): readonly PlanLine[] {
  if (layout.scope !== 'system') return [];
  const prefix = layout.prefix;
  return [
    {
      label: 'ownership',
      text:
        `${SYSTEM_ACCOUNT} owns ${binDirectory(layout)}, ${prefix}/${PACKAGE_DIRECTORY}, ` +
        `${prefix}/share and ${stateDirectory(layout)}; root keeps ${prefix}/${NODE_DIRECTORY} ` +
        `and ${layout.settingsFile}`,
    },
  ];
}

/** `write_environment_file`'s line: written once, and never again. */
function settingsLine({ layout, settingsPresent }: InstallPlanInput): PlanLine {
  return {
    label: 'settings',
    text: `${layout.settingsFile} (${settingsPresent ? 'already there, left alone' : 'create'})`,
  };
}

/** `write_units`' lines: one per daemon, or one saying why there are none. */
function unitLines({
  request,
  layout,
  unitsPresent,
  unitSkipReason: reason,
}: InstallPlanInput): readonly PlanLine[] {
  if (reason !== null) return [{ label: 'unit', text: `skipped: ${reason}` }];
  return request.daemons.map((daemon) => {
    const file = unitFile(layout, unitFileName(daemon));
    return {
      label: 'unit',
      text: unitsPresent.includes(file)
        ? `${file} (already there, left alone; --print-unit shows this version)`
        : `${file} (write, not enabled)`,
    };
  });
}
