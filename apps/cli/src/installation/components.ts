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

/**
 * Where a release's tarballs are published, and the name each component's is
 * published under.
 *
 * This is the second half of the table above, and it exists for the same reason
 * the first half does: `agentplex update` hands npm a URL, and a URL is built
 * from a component, a version and an asset name. `install.sh` builds the same
 * URL out of `RELEASE_DOWNLOAD_URL` and `component_asset`, and this is that
 * pair restated in the one other program that installs a released package.
 *
 * The asset names are constants, per component, for ever: GitHub's
 * `releases/latest/download/<asset>` redirect substitutes the tag into the path
 * and copies the file name through verbatim, so a name carrying a version is a
 * name no URL built from a component and a version can ever match. `npm pack`
 * produces the version-stamped name and the release workflow renames it on the
 * way up. `components.test.ts` holds these against the assembler's own.
 */
export const RELEASE_DOWNLOAD_URL =
  'https://github.com/SoftieSolutions/agentplex/releases/download';

export const COMPONENT_ASSETS: Readonly<Record<Component, string>> = {
  cli: 'agentplex.tgz',
  hub: 'agentplex-hub.tgz',
  server: 'agentplex-server.tgz',
  web: 'agentplex-web.tgz',
};

/**
 * The tarball one release of one component is published at.
 *
 * `release_url` in the installer, with the same three parts in the same order.
 * A version that is not a version never reaches here: the flag reader refuses a
 * pin the release grammar does not accept, and an unpinned component's version
 * came out of a manifest that was parsed.
 */
export function releaseUrl(component: Component, version: string): string {
  return `${RELEASE_DOWNLOAD_URL}/${component}-v${version}/${COMPONENT_ASSETS[component]}`;
}
