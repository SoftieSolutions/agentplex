import {
  protocolDisagreement,
  type Installation,
  type InstalledPackage,
} from '../../installation/installation.js';
import { formatUnits } from '../../installation/units.js';
import type { UnitState } from '../../installation/systemd.js';
import { describeAge, type CachedVersions } from '../../versions/versions-cache.js';

/**
 * `agentplex status` as lines to print, and the verdict that goes with them.
 *
 * Pure, and separate from the gathering, for the reason `doctor`'s formatter is:
 * what an operator reads is then a value a test can assert on rather than
 * something only a terminal has ever seen.
 *
 * ## What this reports, and what it refuses to
 *
 * Installed versions, and -- since the update command exists -- what is
 * available beside them. The refusal underneath that has not moved: **this
 * reaches no network.** The available column is read out of the cache
 * `agentplex update --check` writes, which is a file on this disk like any
 * other, and it is labelled with that file's age. A machine that has never run
 * a check has no column and is told which command makes one.
 *
 * That is the distinction worth keeping when somebody next edits this: the
 * objection was never to reporting what is available, it was to a `status` that
 * is slow or wrong when a registry is down. A cache read cannot be either. The
 * column arrives as a value this function is handed, so there is still nowhere
 * in here a fetch could be smuggled in.
 *
 * What it does report is the protocol, because that is a fact about the
 * artifacts on this disk and needs nothing fetched to check. Four components on
 * four release trains are safe exactly while they agree on it; a set that does
 * not is a machine whose hub and server will connect and refuse each other's
 * frames, with nothing in either log naming the cause. `install.sh` refuses to
 * create that machine and this is what notices one that exists anyway.
 */

/**
 * What `update --check` last wrote, and when this run is reading it.
 *
 * The clock arrives with it rather than being read here, because a formatter
 * that called `Date.now()` would be a formatter whose output cannot be written
 * down in a test.
 */
export interface AvailableVersions {
  readonly cached: CachedVersions;
  readonly now: number;
}

export interface StatusReport {
  readonly lines: readonly string[];
  /**
   * Whether anything here is a failure, which is the exit code.
   *
   * One thing sets it: a unit systemd calls `failed`. That is a service that
   * tried to run and could not, which is unambiguous and is the machine telling
   * us so rather than us deciding.
   *
   * Enabled-but-inactive deliberately does not. It is suspicious -- a unit that
   * is meant to come back at boot and is not running now -- and it is also
   * exactly what a machine mid-maintenance looks like, and what a machine whose
   * operator stopped one daemon on purpose this morning looks like. `status`
   * cannot read intent, and a command that exited non-zero on a state somebody
   * chose would be a command people learn to ignore the exit code of. It is
   * reported, in the line, and the person reading decides.
   *
   * Nor does a protocol disagreement, which is the one that took an argument.
   * It is a genuine fault and it is not a *unit* failure: the exit code here is
   * the answer to "did anything on this machine fail to run", and widening it
   * to "is anything about this machine wrong" makes it the doctor's verdict
   * under another name. The disagreement gets a paragraph of its own instead,
   * which is more than an exit code could have said.
   */
  readonly failed: boolean;
}

/**
 * `units` is `null` for a machine with no `systemctl` on it.
 *
 * A distinct value rather than a list of units with nothing in them, because
 * they are different facts and the report says different things about each. An
 * empty list is a machine whose installer wrote no unit; `null` is a machine
 * that has units and nothing to ask about them, and its unit files are still
 * listed -- they are files this machine has -- with nothing claimed about what
 * they are doing, once, rather than the same sentence repeated under every row.
 */
export function formatStatus(
  installation: Installation,
  units: readonly UnitState[] | null,
  available: AvailableVersions | null = null,
): StatusReport {
  const { layout } = installation;
  const lines = [
    `agentplex status   prefix=${layout.prefix}   scope=${layout.scope}   role=${
      installation.role ?? 'not recorded'
    }`,
    '',
    'packages',
    ...installation.packages.flatMap((one) => packageLines(one, available)),
    ...availableLines(available),
    '',
    'units',
    ...unitBlock(installation, units),
    '',
    'runtime',
    ...runtimeLines(installation),
  ];

  const disagreement = protocolDisagreement(installation);
  if (disagreement !== null) {
    lines.push('', 'protocol', ...disagreementLines(disagreement));
  }

  return { lines, failed: (units ?? []).some((unit) => unit.active === 'failed') };
}

function unitBlock(
  installation: Installation,
  units: readonly UnitState[] | null,
): readonly string[] {
  if (units === null) {
    return [
      '  there is no systemctl on this machine, so nothing here supervises these:',
      ...installation.units.map((unit) => `    ${unit.unit}`),
    ];
  }
  return units.length === 0
    ? [
        `  none in ${installation.layout.unitDirectory}: install.sh writes one per daemon ` +
          "this machine's role runs",
      ]
    : formatUnits(units);
}

/**
 * One package: the component's word, the version, and what it speaks.
 *
 * The component's word rather than the package name, because that is what a tag
 * carries, what `--role` pins and what the operator will type at the update
 * command. The published name is on the line only when there is a problem with
 * it, where it is the thing somebody has to go and look at.
 */
function packageLines(
  installed: InstalledPackage,
  available: AvailableVersions | null,
): readonly string[] {
  // The column is there only when there is a cache to fill it from. A machine
  // that has never run a check reports exactly what it reported before this
  // column existed, rather than a fixed-width gap an operator has to work out
  // the meaning of.
  const line = [
    `  ${installed.component.padEnd(8)}`,
    (installed.state === 'installed' ? (installed.version ?? '?') : installed.state).padEnd(12),
    ...(available === null ? [] : [availableColumn(installed, available).padEnd(16)]),
    installed.protocol === null ? '' : `protocol ${installed.protocol}`,
  ]
    .join(' ')
    .trimEnd();
  return installed.problem === null
    ? [line]
    : [line, `    ${installed.name}: ${installed.problem}`];
}

/**
 * What the cache says about this component, in one column.
 *
 * Empty for a component that is not installed and for one the cache does not
 * name: a hub machine has no server to compare, and a manifest written before a
 * component existed says nothing about it. Neither is a fault, and a column
 * that printed something for them would be inventing a comparison.
 */
function availableColumn(installed: InstalledPackage, available: AvailableVersions | null): string {
  if (available === null || installed.state !== 'installed' || installed.version === null) {
    return '';
  }
  const published = available.cached.manifest[installed.component]?.version;
  if (published === undefined) return '';
  // Equality and not an ordering: what is being answered is "is this the one
  // that is published", and a machine ahead of the manifest is reported with
  // both versions rather than as up to date.
  return published === installed.version ? 'current' : `${published} available`;
}

/**
 * The line under the table saying where the other column came from.
 *
 * The age is the point. This is a cached answer, up to a day old even when it
 * is fresh and older than that on a machine that has been offline, so a column
 * with no date under it would be a claim about a registry this command never
 * asked. A machine with no cache is told which command makes one, rather than
 * being left with a blank column and no explanation.
 */
function availableLines(available: AvailableVersions | null): readonly string[] {
  if (available === null) {
    return [
      '  what is available is not shown: agentplex update --check asks, and this reads',
      '  what it last wrote rather than reaching a network of its own',
    ];
  }
  return [
    `  available from ${available.cached.source}, checked ${describeAge(
      available.now - available.cached.checkedAt,
    )}`,
  ];
}

function runtimeLines(installation: Installation): readonly string[] {
  const runtime = installation.runtime;
  return runtime.kind === 'installed'
    ? [`  node ${runtime.version}   installed by install.sh, in ${installation.layout.prefix}/node`]
    : [
        // Not "no runtime". The daemons are started by a unit that names an
        // interpreter outright, and install.sh records one only when it
        // unpacked one -- so the honest statement is that this prefix does not
        // own a Node, which is a different thing from there not being one.
        '  not recorded here: install.sh stamps a runtime only when it installed one,',
        "  so this install adopted a node the machine already had. The unit's ExecStart",
        '  names the one the daemons are started with.',
      ];
}

function disagreementLines(declared: readonly InstalledPackage[]): readonly string[] {
  return [
    '  these components do not agree, and two components that disagree about the',
    '  protocol do not talk to each other:',
    ...declared.map((one) => `    ${one.component.padEnd(8)} protocol ${one.protocol ?? '?'}`),
    '  A protocol change releases every affected component together, so this is a',
    '  machine that was upgraded in halves rather than a choice to make.',
  ];
}
