/**
 * The four things a machine installs, by the word a release tag names them
 * with, and the package npm writes each into.
 *
 * A third copy of this table, and the third is worth its place. The assembler
 * owns it because it is what builds the tarballs; `install.sh` restates it
 * because a bootstrap script cannot import anything; and this program restates
 * it because `status` reads a manifest off a disk and has to know which
 * directory to look in. The names happen to end in the component's own word
 * today, and what a command reports is the wrong thing to have depend on that
 * continuing to be true -- so this is a table and not a template, exactly as
 * `component_package` in the installer is.
 *
 * `components.test.ts` holds it against the assembler's own, the way
 * `install.sh.integration.test.ts` holds the script's against it. A rename in
 * the assembler fails here rather than as a `status` that reports every package
 * absent on a machine where all four are installed.
 */

/** The word a tag carries, `versions.json` keys on, and `--role` pins. */
export type Component = 'cli' | 'hub' | 'server' | 'web';

/** In the order `status` lists them: the command first, then what a role adds. */
export const COMPONENTS: readonly Component[] = ['cli', 'hub', 'server', 'web'];

export const COMPONENT_PACKAGES: Readonly<Record<Component, string>> = {
  cli: '@softiesolutions/agentplex',
  hub: '@softiesolutions/agentplex-hub',
  server: '@softiesolutions/agentplex-server',
  web: '@softiesolutions/agentplex-web',
};

/**
 * The package holding one daemon's compiled entry.
 *
 * The installer's `daemon_package` with the two components that are not daemons
 * refused, and for the reason it gives: `cli` holds no daemon and `web` is
 * static files, so a lookup that fell through to a plausible-looking name would
 * point the foreground command this prints at a file that is not there.
 */
export function daemonPackage(daemon: string): string | null {
  return daemon === 'hub' || daemon === 'server' ? COMPONENT_PACKAGES[daemon] : null;
}

/**
 * A daemon's compiled entry inside its package, as the unit's ExecStart names
 * it.
 *
 * The layout inside a published package is the workspace's, on purpose, so this
 * one expression is correct in a checkout, in the image and under
 * `<prefix>/lib/node_modules` alike. `daemon_command` in the installer builds
 * the same path out of the same two halves.
 */
export function daemonEntrypoint(daemon: string): string {
  return `apps/${daemon}/dist/main.js`;
}
