import { compareVersions, type VersionsManifest } from '@agentplex/release';
import { COMPONENTS, releaseUrl, type Component } from '../../installation/components.js';
import type { Installation, InstalledPackage } from '../../installation/installation.js';
import type { AskedComponent } from './update-flags.js';

/**
 * What this run would do, worked out before anything is stopped.
 *
 * Pure, and separate from the doing, for the reason `status`'s formatter is:
 * what an operator reads and what order things happen in are then values a test
 * can assert on rather than a sequence only a real machine has ever performed.
 * The ordering constraints this command has are constraints on a value here.
 *
 * ## The one that is not obvious: the command updates itself last
 *
 * `update` runs out of the CLI's own package and overwrites it. Modules already
 * loaded are safe -- Node has read them -- but anything imported *after* npm
 * has replaced the tree is not, and the subcommands here are deliberately lazy
 * imports. So the plan puts the CLI's own package in an npm invocation of its
 * own, after every other package, and the flow resolves everything it needs
 * before the first one runs. A single invocation carrying all four would work
 * exactly until the first time this command needed a module it had not loaded
 * yet, and the failure would be a half-updated machine reporting a module
 * resolution error.
 *
 * Everything else is one invocation, which is `install.sh`'s rule and its
 * reason: npm resolves a set together, so a machine ends up with the set or
 * with none of it -- and a hub whose client package failed is a hub serving
 * 503, which is worse to arrive at halfway through a loop than at a failed
 * command.
 */

/** What would happen to one component. */
export interface ComponentPlan {
  readonly component: Component;
  readonly installed: string | null;
  /** What it would be moved to, or `null` when this run cannot say. */
  readonly target: string | null;
  /** The tarball, for the components that are actually being installed. */
  readonly url: string | null;
  /** The protocol this component would speak afterwards, as far as anything knows. */
  readonly protocol: number | null;
  readonly action: ComponentAction;
  /** Why there is no target, when there is none. */
  readonly problem: string | null;
}

export type ComponentAction =
  /** Installed here, and a different version would be put in its place. */
  | 'update'
  /** Installed here, at the version that would be installed. */
  | 'current'
  /** Installed here, at something newer than what is published. */
  | 'ahead'
  /** Installed here, and nothing could be found out about it. */
  | 'unknown'
  /** Not installed here. A hub machine has no server, and that is not a fault. */
  | 'absent';

/** One npm invocation, in the order the flow runs them. */
export interface PackageInstall {
  /** The tarball URLs npm is handed, as one resolution. */
  readonly specs: readonly string[];
  /** The components those URLs carry, for the line that announces it. */
  readonly components: readonly Component[];
  /** Why this is an invocation of its own. */
  readonly reason: string;
}

export interface UpdatePlan {
  readonly components: readonly ComponentPlan[];
  /** In order. Empty when there is nothing to install. */
  readonly installs: readonly PackageInstall[];
  /**
   * Components that would not agree about the protocol afterwards, or `null`.
   *
   * `install.sh`'s tripwire, asked of the machine this run would leave behind
   * rather than of the one it found. It is the check that makes `agentplex
   * update hub` on a `both` machine safe: a hub moved across a protocol change
   * on its own is a hub and a server that will connect and refuse each other's
   * frames, with nothing in either log naming the cause.
   */
  readonly disagreement: readonly ComponentPlan[] | null;
}

/** The CLI's own component: the one that has to be installed last. */
const SELF: Component = 'cli';

export interface PlanInputs {
  readonly installation: Installation;
  /** What the manifest said, or `null` when it could not be read. */
  readonly manifest: VersionsManifest | null;
  /** Why there is no manifest, when there is none. */
  readonly problem: string | null;
  /** The components named on the command line. Empty means everything installed. */
  readonly asked: readonly AskedComponent[];
}

export function planUpdate({ installation, manifest, problem, asked }: PlanInputs): UpdatePlan {
  const wanted = new Map(asked.map((one) => [one.component, one.version]));
  const components = COMPONENTS.map((component) =>
    planComponent(component, installation, manifest, problem, asked.length === 0, wanted),
  );

  const moving = components.filter((one) => one.action === 'update' && one.url !== null);
  const others = moving.filter((one) => one.component !== SELF);
  const self = moving.filter((one) => one.component === SELF);

  const installs: PackageInstall[] = [];
  if (others.length > 0) {
    installs.push({
      specs: others.map((one) => one.url ?? ''),
      components: others.map((one) => one.component),
      reason: 'npm resolves these together, so this machine gets the set or none of it',
    });
  }
  if (self.length > 0) {
    installs.push({
      specs: self.map((one) => one.url ?? ''),
      components: self.map((one) => one.component),
      reason: 'last, because this command is running out of the package it replaces',
    });
  }

  return { components, installs, disagreement: disagreementAfter(components) };
}

/**
 * One component's line.
 *
 * A component that is not installed is `absent` and never a problem: a hub
 * machine installs no server package, and a run that reported that as missing
 * would make every correctly installed machine in a fleet look broken. Naming
 * one on the command line is the other case entirely, and it is refused before
 * this is reached -- see `refuseAbsent`.
 */
function planComponent(
  component: Component,
  installation: Installation,
  manifest: VersionsManifest | null,
  problem: string | null,
  everything: boolean,
  wanted: ReadonlyMap<Component, string | null>,
): ComponentPlan {
  const installed = installation.packages.find((one) => one.component === component);
  const version = installedVersion(installed);
  const base = {
    component,
    installed: version,
    target: null,
    url: null,
    protocol: installed?.protocol ?? null,
    problem: null,
  } as const;

  if (version === null) return { ...base, action: 'absent' };
  // Named components only, when any were named. A machine's other packages are
  // still reported -- what is installed is worth seeing -- but with nothing
  // claimed about where they would go.
  if (!everything && !wanted.has(component)) return { ...base, action: 'current' };

  const pinned = wanted.get(component) ?? null;
  if (pinned !== null) {
    // A pin names a release outright, so nothing is resolved and the manifest
    // is not consulted -- which is also why a pinned component's protocol is
    // unknown here. `install.sh` pays one small download per pin to find that
    // out before installing; this command has the same question and answers it
    // by leaving the number out of the agreement check rather than guessing.
    return {
      ...base,
      target: pinned,
      url: releaseUrl(component, pinned),
      protocol: null,
      action: pinned === version ? 'current' : 'update',
    };
  }

  if (manifest === null) {
    return { ...base, action: 'unknown', problem: problem ?? 'the release manifest was not read' };
  }

  const entry = manifest[component];
  if (entry === undefined) {
    return {
      ...base,
      action: 'unknown',
      problem: 'the release manifest names no such component, so there is nothing to move to',
    };
  }

  const order = compareVersions(entry.version, version);
  if (order === null) {
    return {
      ...base,
      action: 'unknown',
      problem: `${version} and ${entry.version} cannot be compared`,
    };
  }
  if (order === 0)
    return { ...base, target: entry.version, protocol: entry.protocol, action: 'current' };
  if (order < 0) {
    // Installed ahead of what is published. Reported and not acted on: a
    // machine running a release candidate, or one an operator pinned forward on
    // purpose, is not a machine this should quietly move backwards.
    return {
      ...base,
      target: entry.version,
      protocol: installed?.protocol ?? null,
      action: 'ahead',
    };
  }

  return {
    ...base,
    target: entry.version,
    url: releaseUrl(component, entry.version),
    protocol: entry.protocol,
    action: 'update',
  };
}

function installedVersion(installed: InstalledPackage | undefined): string | null {
  return installed !== undefined && installed.state === 'installed' ? installed.version : null;
}

/**
 * The protocols this machine would be left speaking, and whether they are one
 * number.
 *
 * A component with no declared protocol is left out rather than counted as a
 * disagreement -- a pinned release, or a package from before the field existed.
 * "This one does not say" is a different and smaller fact than "these two say
 * different things", which is the same rule `protocolDisagreement` follows
 * about an installed machine.
 */
function disagreementAfter(components: readonly ComponentPlan[]): readonly ComponentPlan[] | null {
  const declared = components.filter((one) => one.action !== 'absent' && one.protocol !== null);
  return new Set(declared.map((one) => one.protocol)).size > 1 ? declared : null;
}

/**
 * The components named on the command line that this machine does not have.
 *
 * Separate from the plan because it is a refusal rather than a report: `setup`
 * installs what is missing and `update` updates what is there, and the two
 * verbs stay apart.
 */
export function absentlyNamed(
  installation: Installation,
  asked: readonly AskedComponent[],
): readonly Component[] {
  return asked
    .filter((one) => {
      const installed = installation.packages.find((each) => each.component === one.component);
      return installed === undefined || installed.state !== 'installed';
    })
    .map((one) => one.component);
}

/** Whether this plan would change anything at all. */
export function planIsEmpty(plan: UpdatePlan): boolean {
  return plan.installs.length === 0;
}

/** Whether anything in the plan could not be worked out. */
export function planHasUnknowns(plan: UpdatePlan): boolean {
  return plan.components.some((one) => one.action === 'unknown');
}

/**
 * The version table, as `--check` prints it and as the plan opens with.
 *
 * One line per component: what is here, what is available, and what that means.
 * The component's word rather than the package name, because that is what a tag
 * carries, what a pin names and what an operator types at this command.
 */
export function formatComponents(plan: UpdatePlan): readonly string[] {
  return plan.components.flatMap((one) => {
    const line = [
      `  ${one.component.padEnd(8)}`,
      (one.installed ?? 'absent').padEnd(12),
      describeAction(one).padEnd(24),
    ]
      .join(' ')
      .trimEnd();
    return one.problem === null ? [line] : [line, `    ${one.problem}`];
  });
}

function describeAction(plan: ComponentPlan): string {
  switch (plan.action) {
    case 'absent':
      return '';
    case 'current':
      return 'up to date';
    case 'ahead':
      return `ahead of ${plan.target ?? '?'}`;
    case 'unknown':
      return 'could not check';
    case 'update':
      return `-> ${plan.target ?? '?'}`;
  }
}

/** The paragraph a disagreement gets, which is more than an exit code could say. */
export function formatDisagreement(declared: readonly ComponentPlan[]): readonly string[] {
  return [
    '  this run would leave components that do not agree, and two components that',
    '  disagree about the protocol do not talk to each other:',
    ...declared.map((one) => `    ${one.component.padEnd(8)} protocol ${one.protocol ?? '?'}`),
    '  A protocol change releases every affected component together, so update them',
    '  together: agentplex update with no component named takes the whole machine.',
  ];
}
