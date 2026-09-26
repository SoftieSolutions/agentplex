import { readPin, type Pin } from '@agentplex/release';
import type { Component } from '../../installation/components.js';
import type { Daemon } from '../../installation/unit-file.js';

/**
 * What `agentplex install` was asked to do, in `install.sh`'s grammar.
 *
 * Word for word, refusals included, and that is the decision rather than a
 * convenience: the handover after this command has `install.sh` pass its own
 * arguments through unchanged, so a word the two read differently would be an
 * install that means one thing typed at the script and another once the script
 * hands over. Every refusal below is the script's `die` sentence.
 *
 * The one reader of `--prefix` and `--system` the other installation commands
 * share (`lookup-flags.ts`) is deliberately not this. It takes `--prefix <v>`
 * as two words and resolves `..` away; `install.sh` takes `--prefix=` only,
 * refuses `..` outright -- the path a person read must be the path that would
 * be removed -- refuses a one-level prefix like `/opt`, and trims a trailing
 * slash. A prefix this accepts is one the script would have created.
 *
 * `--no-setup`, `--uninstall` and `--version` stay the script's: setup, the
 * uninstall and the script's own version are not part of what this command
 * does, so here they are unknown options like any other.
 */

export const DRY_RUN_FLAG = '--dry-run';
export const PRINT_UNIT_FLAG = '--print-unit';

/** What `AGENTPLEX_ROLE` records: the word for the machine, never its pins. */
export type Role = 'hub' | 'server' | 'both';

/** The daemons `--role` can name, one component each. */
type RoleComponent = Daemon;

export interface ResolvedRole {
  readonly role: Role;
  /** One unit each, in the order the script renders them. */
  readonly daemons: readonly Daemon[];
  /** What this role installs: `INSTALL_COMPONENTS`, in its order. */
  readonly components: readonly Component[];
}

export interface InstallRequest extends ResolvedRole {
  /** A pin per component that was given one: `--role=<c>@<pin>` and `--package-version`. */
  readonly pins: Readonly<Partial<Record<Component, Pin>>>;
  /** Validated and trimmed as `validate_prefix` does, or `null` for the scope's default. */
  readonly prefix: string | null;
  readonly system: boolean;
  readonly dryRun: boolean;
  readonly printUnit: boolean;
}

export type InstallFlags =
  | { readonly ok: true; readonly value: InstallRequest }
  | { readonly ok: false; readonly problem: string };

class Refusal extends Error {}

/** The script's `quote`: the word in double quotes, whatever it holds. */
function quote(word: string): string {
  return `"${word}"`;
}

/**
 * Reads argv as `parse_arguments` does: in order, stopping at the first thing
 * it refuses, then the default role, then the prefix.
 */
export function readInstallFlags(argv: readonly string[]): InstallFlags {
  const named: RoleComponent[] = [];
  const pins: Partial<Record<Component, Pin>> = {};
  let prefix: string | null = null;
  let system = false;
  let dryRun = false;
  let printUnit = false;

  const setPin = (component: Component, word: string, flag: string): void => {
    if (word === '') {
      throw new Refusal(
        `${flag} was given with nothing after it, which is usually an unset variable: name a ` +
          `version, as ${flag}1.4.0, or leave the pin off to take what is current`,
      );
    }
    const pin = readPin(word);
    if (pin === null) {
      throw new Refusal(
        `${quote(word)} is not a version this can install: a pin is an exact ` +
          `<major>.<minor>.<patch>, naming the release tag ${component}-v<version>, or a series ` +
          '-- <major>.<minor> or <major> -- which resolves to the newest release published ' +
          'under it',
      );
    }
    if (pins[component] !== undefined) {
      throw new Refusal(
        `${component} is pinned twice, and two versions of one component is a contradiction ` +
          'rather than a last-one-wins',
      );
    }
    pins[component] = pin;
  };

  const addRole = (value: string): void => {
    const at = value.indexOf('@');
    const component = at === -1 ? value : value.slice(0, at);
    const word = at === -1 ? null : value.slice(at + 1);

    if (component === 'both') {
      if (word !== null) {
        throw new Refusal(
          '--role=both names two components and a version names one: pin them separately, as ' +
            '--role=hub@<version> --role=server@<version>',
        );
      }
      addRole('hub');
      addRole('server');
      return;
    }
    if (component === 'cli' || component === 'web') {
      throw new Refusal(
        `${quote(component)} is not a role: the agentplex command goes on every machine ` +
          'whatever it runs, and the client is part of being a hub. Pin the command with ' +
          '--package-version=<version>',
      );
    }
    if (component !== 'hub' && component !== 'server') {
      throw new Refusal(`unknown role ${quote(component)}: expected one of hub, server, both`);
    }
    if (named.includes(component)) {
      throw new Refusal(
        `--role names ${component} twice: two answers to one question is a contradiction ` +
          'rather than a last-one-wins, so nothing was installed',
      );
    }
    named.push(component);
    if (word !== null) setPin(component, word, `--role=${component}@`);
  };

  try {
    for (const argument of argv) {
      if (argument.startsWith('--role=')) {
        addRole(argument.slice('--role='.length));
      } else if (argument.startsWith('--package-version=')) {
        setPin('cli', argument.slice('--package-version='.length), '--package-version=');
      } else if (argument.startsWith('--prefix=')) {
        prefix = argument.slice('--prefix='.length);
        if (prefix === '') {
          throw new Refusal(
            '--prefix was given with nothing after it, which is usually an unset variable: name ' +
              'the directory, or leave the flag off to take the default',
          );
        }
      } else if (argument === '--system') {
        system = true;
      } else if (argument === DRY_RUN_FLAG) {
        dryRun = true;
      } else if (argument === PRINT_UNIT_FLAG) {
        printUnit = true;
      } else {
        throw new Refusal(`unknown option ${argument}`);
      }
    }

    // The default, applied after the loop so that `both` arrives through the
    // one function that knows what `both` means.
    if (named.length === 0) addRole('both');

    return {
      ok: true,
      value: {
        ...resolveRole(named),
        pins,
        prefix: prefix === null ? null : validatePrefix(prefix),
        system,
        dryRun,
        printUnit,
      },
    };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: error.message };
    throw error;
  }
}

/**
 * `validate_prefix`: absolute, no `..`, at least two directories deep, and a
 * trailing slash trimmed before anything is built out of it.
 */
function validatePrefix(given: string): string {
  if (!given.startsWith('/')) {
    throw new Refusal(`--prefix must be an absolute path, not ${quote(given)}`);
  }
  if (`/${given}/`.includes('/../')) {
    throw new Refusal(
      `--prefix must name a directory outright, and ${quote(given)} walks through ..`,
    );
  }
  let prefix = given;
  while (prefix !== '/' && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  if (prefix.slice(0, prefix.lastIndexOf('/')) === '') {
    throw new Refusal(
      `--prefix must be at least two directories deep, and ${quote(prefix)} is not: this is the ` +
        'directory an install fills and --uninstall empties',
    );
  }
  return prefix;
}

/**
 * `resolve_role`: the word this machine records, the daemons that get a unit
 * and the components that get installed. The command is in every row because
 * `setup` and `doctor` belong on every machine, and the client in every row a
 * hub is in, because a hub with no client serves 503.
 */
export function resolveRole(named: readonly RoleComponent[]): ResolvedRole {
  const hub = named.includes('hub');
  const server = named.includes('server');
  if (hub && server) {
    return {
      role: 'both',
      daemons: ['hub', 'server'],
      components: ['cli', 'hub', 'web', 'server'],
    };
  }
  if (hub) return { role: 'hub', daemons: ['hub'], components: ['cli', 'hub', 'web'] };
  return { role: 'server', daemons: ['server'], components: ['cli', 'server'] };
}

/** The usage, which is also where the grammar is written down for a person. */
export function installUsage(): string {
  return [
    'Usage: agentplex install [options]',
    '',
    '  Answers the two questions install.sh answers without changing the machine. It',
    '  does not install anything yet: install.sh is how to install agentplex.',
    '',
    '  --role=<hub|server|both>[@<version>]',
    '                               which roles this machine runs (default: both).',
    '                               Repeatable, and each may pin its own version;',
    '                               `both` names two components, so it takes no @',
    '  --system                     install under a dedicated service account (needs root)',
    '  --package-version=<version>  pin the agentplex command, which every role installs',
    '  --prefix=<directory>         install somewhere other than the default prefix',
    `  ${DRY_RUN_FLAG}                    print what an install would do and change nothing`,
    `  ${PRINT_UNIT_FLAG}                 print the systemd units an install would write`,
    '',
    '  A version is exact -- 1.4.0, naming the release tag <component>-v<version> --',
    '  or a series: 1.4 takes the newest 1.4.x and 1 the newest 1.x, never a',
    '  prerelease. A dry run reads the manifest only from AGENTPLEX_VERSIONS, a',
    '  directory holding versions.json; it downloads nothing.',
  ].join('\n');
}
