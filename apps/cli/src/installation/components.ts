/**
 * The four things a machine installs, by the word a release tag names them
 * with, and the package npm writes each into.
 *
 * A third copy of this table, and the third is worth its place. The assembler
 * owns it because it is what builds the tarballs; `install.sh` keeps the names
 * in `component_package` because a bootstrap script cannot import anything and
 * `--uninstall` removes all four; and this program has its own because `status`
 * reads a manifest off a disk, and `install` writes one, and each has to know
 * which directory. The names happen to end in the component's own word today,
 * and what a command reports is the wrong thing to have depend on that
 * continuing to be true -- so this is a table and not a template, exactly as
 * the installer's is.
 *
 * `components.test.ts` holds it against the assembler's own. A rename in the
 * assembler fails there rather than as a `status` that reports every package
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
 * The table above with the two components that are not daemons refused: `cli`
 * holds no daemon and `web` is static files, so a lookup that fell through to a
 * plausible-looking name would point the foreground command this prints, or a
 * unit's ExecStart, at a file that is not there.
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
 * `<prefix>/lib/node_modules` alike. The unit fixtures `unit-file.test.ts`
 * reads name it as the installer did before it handed the units over.
 */
export function daemonEntrypoint(daemon: string): string {
  return `apps/${daemon}/dist/main.js`;
}

/**
 * The command the CLI's package puts on a machine's PATH, and the file inside
 * that package it runs.
 *
 * `install.sh` has the same two, `PACKAGE_NAME` and `CLI_ENTRYPOINT`, because
 * it makes the link for the command it bootstraps, and this program makes it
 * for every install after that: npm made it while packages were installed with
 * `--global`, and now that each is installed against its own shrinkwrap nothing
 * makes it but the installer, `agentplex install` and `agentplex update`.
 * `components.test.ts` holds these against the manifest's `bin`, and
 * `install.sh.integration.test.ts` holds the link the script makes against the
 * assembler's entry.
 */
export const CLI_COMMAND = 'agentplex';
export const CLI_ENTRYPOINT = 'apps/cli/dist/main.js';

/**
 * Where a release's tarballs are published, and the name each component's is
 * published under.
 *
 * This is the second half of the table above, and it exists for the same reason
 * the first half does: `agentplex update` downloads a URL, and a URL is built
 * from a component, a version and an asset name. `install.sh` builds the
 * command's out of its own `RELEASE_DOWNLOAD_URL` and `CLI_ASSET`, for the one
 * tarball it downloads before this program exists on the machine; every other
 * component's is built here.
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
