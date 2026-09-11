import { join } from 'node:path';

/**
 * Where an install put things, which is the one question `start`, `stop` and
 * `status` all have to answer before they can do anything at all.
 *
 * This is not a second opinion about the layout. `install.sh`'s `resolve_layout`
 * has exactly two branches and each sets four things together -- the prefix, the
 * settings file, the unit directory and the scope -- and the two functions below
 * are those two branches, restated in the one other program that has to find the
 * same files. Restated rather than imported, because the installer is a shell
 * script fetched over HTTPS and run on a machine with nothing on it: there is
 * nothing to import, and a second download would be a second thing to get wrong.
 * `installation.test.ts` holds these constants against the script's own, so a
 * change to one side fails here rather than at a path that is not there.
 *
 * What matters about the pairing is that the scope is not guessed separately.
 * `uninstall_units` picks its `systemctl` off `UNIT_SCOPE`, which came out of the
 * same branch as `ENV_FILE`, so on that machine "which settings file" and "which
 * systemctl" are one decision made once. They are one decision here too: a
 * `Layout` carries both, and nothing downstream may take one from one layout and
 * one from another.
 */

/**
 * Which systemd a unit belongs to, and therefore which `systemctl` reaches it.
 *
 * The unit *file name* is the same in both -- `agentplex-hub.service` in
 * `~/.config/systemd/user` and in `/etc/systemd/system` alike -- so the scope is
 * never recoverable from the name of a unit, only from where it was found.
 */
export type UnitScope = 'user' | 'system';

/** Where the installer puts the settings, and where setup fills them in. */
export const SETTINGS_FILE_NAME = 'agentplex.env';

/** The fleet layout, from `install.sh`'s `--system` branch. */
export const SYSTEM_PREFIX = '/opt/agentplex';
export const SYSTEM_CONFIG_DIR = '/etc/agentplex';
export const SYSTEM_UNIT_DIR = '/etc/systemd/system';

/** The per-user layout, from the branch a plain run takes. */
export const USER_PREFIX_DIRECTORY = '.agentplex';
export const USER_UNIT_DIRECTORY = join('.config', 'systemd', 'user');

/**
 * The directory the runtime is unpacked into, and the file `install.sh` stamps
 * the release into after it unpacks one.
 *
 * A runtime the script adopted from the machine leaves no stamp and no
 * directory, which is exactly what makes the stamp worth reading: its presence
 * is the difference between a Node this install owns and one it borrowed, and
 * `uninstall_node` already refuses to remove a directory without it.
 */
export const NODE_DIRECTORY = 'node';
export const NODE_STAMP = '.agentplex-node-version';

/** Where npm writes a globally installed package under a prefix. */
export const PACKAGE_DIRECTORY = join('lib', 'node_modules');

export interface Layout {
  readonly scope: UnitScope;
  /** The directory the install filled, and `--uninstall` would empty. */
  readonly prefix: string;
  /** The `EnvironmentFile` both units read, whether or not it is there yet. */
  readonly settingsFile: string;
  /** Where the units for this scope live, whether or not any were written. */
  readonly unitDirectory: string;
}

/**
 * The fleet layout. The settings file is the one thing that is *not* inside the
 * prefix here, and deliberately: `install.sh` puts it under `/etc` so that root
 * owns it and the service account can read but not rewrite its own settings. A
 * reader that assumed "beside the prefix" would find nothing on every machine
 * installed the supported way.
 */
export function systemLayout(prefix: string = SYSTEM_PREFIX): Layout {
  return {
    scope: 'system',
    prefix,
    settingsFile: join(SYSTEM_CONFIG_DIR, SETTINGS_FILE_NAME),
    unitDirectory: SYSTEM_UNIT_DIR,
  };
}

/**
 * The per-user layout, which needs a home because both halves of it hang off
 * one: the prefix under it and the user manager's unit directory in it.
 */
export function userLayout(home: string, prefix?: string): Layout {
  const owned = prefix ?? join(home, USER_PREFIX_DIRECTORY);
  return {
    scope: 'user',
    prefix: owned,
    settingsFile: join(owned, SETTINGS_FILE_NAME),
    unitDirectory: join(home, USER_UNIT_DIRECTORY),
  };
}

/** One daemon's unit file, in this scope. */
export function unitFile(layout: Layout, unit: string): string {
  return join(layout.unitDirectory, unit);
}

/** Where npm put one globally installed package under this prefix. */
export function packageDirectory(layout: Layout, name: string): string {
  return join(layout.prefix, PACKAGE_DIRECTORY, name);
}

/** The runtime directory `install.sh` unpacks a Node into, and its stamp. */
export function nodeStampFile(layout: Layout): string {
  return join(layout.prefix, NODE_DIRECTORY, NODE_STAMP);
}

/** The interpreter inside that directory, which is what a unit's ExecStart names. */
export function nodeBinary(layout: Layout): string {
  return join(layout.prefix, NODE_DIRECTORY, 'bin', 'node');
}
