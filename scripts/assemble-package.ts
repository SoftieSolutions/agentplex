import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@agentplex/protocol';
import { z } from 'zod';

/**
 * Assemble the trees that get published, one per package.
 *
 * A bare machine must not need pnpm, vite or a checkout, so each package
 * carries the compiled programs it runs, the compiled workspace packages those
 * import, and whatever else they read off a disk. Installation is
 * `npm install --global <the packages this machine's role needs>`.
 *
 * ## Four packages, and what a machine stops carrying
 *
 * There was one tarball, and every machine got all of it. The split is
 * `@softiesolutions/agentplex` (the command: setup, doctor, help),
 * `-hub` (the hub daemon and its migrations), `-server` (the server daemon) and
 * `-web` (the built PWA the hub serves).
 *
 * The payoff is concrete rather than tidy. A hub machine no longer carries the
 * server's code, and -- the part that matters -- nothing it installs can fail
 * for want of a C++ compiler. The hub package and the client reach node-pty
 * nowhere at all, and the command, which every role installs for `setup` and
 * `doctor`, declares it optional. That compile is the single most failure-prone
 * step of any install: node-pty ships no Linux prebuild, so npm builds it from
 * source, and node-gyp needs python3, make and a compiler that a stock
 * `debian:bookworm-slim` does not have. The one package that requires it is the
 * server's, on the one machine that cannot work without it.
 *
 * It also makes the client separately replaceable, which is what lets a later
 * change offer `agentplex update web` without shipping a new hub.
 *
 * The cost, stated rather than hidden: `protocol`, `node-shared` and
 * `providers` are bundled into three of the four tarballs. That is the correct
 * consequence of bundling packages that are published under no name of their
 * own -- each one has to be reachable from the program that imports it, and
 * npm has no way to share a bundled subtree between packages. The alternative
 * is publishing them as packages in their own right, which is a bigger decision
 * about four more registry entries and their versioning, and nobody has taken
 * it.
 *
 * ## One build, four release trains
 *
 * A tag names one component and one version -- `hub-v1.2.0` -- and assembles
 * that component alone. The point of the split was that a CLI fix should stop
 * forcing every server on the fleet to recompile a native addon, and four
 * packages cut at one version from one tag would have left exactly that
 * coupling in place under four names.
 *
 * Without a tag all four are assembled at the workspace's own `0.0.0`, which is
 * what a contributor and the container check want: a set of tarballs from one
 * build, installable from a directory, publishable nowhere.
 *
 * What holds the trains together is `PROTOCOL_VERSION`, written into every
 * published manifest below. Independent versions are safe exactly while the
 * components agree on it, and a fact about the artifact is the only form of
 * that claim an installed machine can check.
 *
 * ## The layout inside every package is the workspace's, on purpose
 *
 * The obvious package is a flat one: `dist/`, `migrations/` at the root. It is
 * also a second layout, and a second layout means a second set of relative
 * paths that exist only in the published artifact and are therefore exercised
 * by nothing until somebody installs it. `apps/hub/dist/main.js` resolves its
 * migrations as `../migrations`; that expression is correct from source, correct
 * in the runtime image, and correct here, because all three keep one layout.
 * Packaging preserves the invariant rather than adding an exception to it.
 *
 * The client is the one thing that stopped being a relative path, and it
 * stopped because it stopped being in the same package: `apps/hub/src/web/
 * web-package.ts` resolves `@softiesolutions/agentplex-web` instead, which is
 * one specifier that works in a checkout, in the image and under
 * `<prefix>/lib/node_modules` alike. The client's package is the one whose
 * contents are laid out as its app rather than as the workspace, and the
 * argument for that is at `WEB` below.
 *
 * ## The contents are data
 *
 * A target's `entries` is the whole of what its tarball holds. A test can read
 * them, and an entry whose source was never built stops the assembly with the
 * paths named, rather than shipping a package that installs and then serves 503
 * forever.
 */

/**
 * The four release trains, by the word a tag names them with.
 *
 * A component is not the package name and not the app directory, and it is
 * worth its own word rather than being derived from either. It is what a tag
 * carries (`hub-v1.2.0`), what `versions.json` keys on, what `install.sh`
 * writes into a download URL, and what `--role=hub@1.3.0` pins -- four readers
 * that have to agree, none of which should be parsing a scope off a package
 * name to get there.
 */
export type Component = 'cli' | 'hub' | 'server' | 'web';

/** The published names, in one place, because several things have to agree. */
export const CLI_PACKAGE = '@softiesolutions/agentplex';
export const HUB_PACKAGE = '@softiesolutions/agentplex-hub';
export const SERVER_PACKAGE = '@softiesolutions/agentplex-server';
export const WEB_PACKAGE = '@softiesolutions/agentplex-web';

/** The manifest the bin belongs to: this app's. */
export const BIN_APP = 'apps/cli';

/**
 * The file `bin` links, in the package and in the workspace alike.
 *
 * Named once because two things have to agree about it: the manifest, and the
 * check that it is startable. `bin` is a path and not an interpreter -- a file
 * without a `#!` line is handed to the shell, which reads the first `import`
 * statement as a command name -- and nothing in this repository would notice,
 * because every other way of starting a program here says `node` out loud.
 */
export const ENTRYPOINT = `${BIN_APP}/dist/main.js`;

/**
 * The daemons, by name.
 *
 * Each is a package of its own now, and each is started by a systemd unit
 * naming `<prefix>/lib/node_modules/<that package>/apps/<daemon>/dist/main.js`,
 * or by the image running the same file. Nobody types either name: nothing in
 * `apps/cli` dispatches to a daemon, and `apps/cli/src/programs.test.ts` reads
 * this list to assert that the bin holds no command by any of these names and
 * can still say what each one is.
 */
export const DAEMONS: readonly string[] = ['hub', 'server'];

export interface BundledPackage {
  readonly name: string;
  /** Relative to the workspace root. */
  readonly directory: string;
}

const PROTOCOL: BundledPackage = { name: '@agentplex/protocol', directory: 'packages/protocol' };
const NODE_SHARED: BundledPackage = {
  name: '@agentplex/node-shared',
  directory: 'packages/node-shared',
};
const PROVIDERS: BundledPackage = { name: '@agentplex/providers', directory: 'packages/providers' };
/**
 * The `versions.json` schema, which travels in the command's package and in no
 * other. `agentplex update` is the only program that reads the manifest off the
 * network, and the daemons have no version question to ask.
 */
const RELEASE: BundledPackage = { name: '@agentplex/release', directory: 'packages/release' };
const PTY: BundledPackage = { name: '@agentplex/pty', directory: 'packages/pty' };

/**
 * What every program in this repository imports, and the client does not.
 *
 * Every one is published under no name of its own, so each travels inside a
 * tarball as a bundled dependency, at the one path Node's resolver reaches from
 * the compiled program above it. A package a program imports that is not in its
 * target's list stops the assembly by name, rather than shipping a tarball
 * whose first import fails.
 */
const SHARED: readonly BundledPackage[] = [PROTOCOL, NODE_SHARED, PROVIDERS];

/**
 * The one install script, at the workspace path, in a package and in the
 * workspace alike. It lives in the pty package because the helper it repairs is
 * node-pty's, and node-pty is declared there and nowhere else. It resolves
 * node-pty through `createRequire`, which from this path walks up to the
 * package's own `node_modules` in a published tree exactly as it walks up to
 * `packages/pty/node_modules` in a checkout.
 *
 * It travels in the two packages that carry `@agentplex/pty` and in neither of
 * the others: the hub package has no node-pty to repair, and the client is
 * static files.
 */
export const POSTINSTALL_SCRIPT = 'packages/pty/scripts/node-pty-postinstall.js';

/** One thing copied into a package, and the path that proves it arrived. */
export interface PackageEntry {
  /** Relative to the workspace root. */
  readonly from: string;
  /** Relative to the package root, and the same as `from` wherever it can be. */
  readonly to: string;
  readonly kind: 'directory' | 'file';
  /**
   * A path inside `from` whose absence means that source was never built. A
   * directory that exists and is empty is the shape a half-finished build
   * leaves behind, and it is indistinguishable from a good one by `stat` alone.
   */
  readonly proof?: string;
  /**
   * Given the name of a file inside `from`, whether to leave it behind. It is
   * asked about file names only: see `copyFilter`.
   */
  readonly exclude?: (name: string) => boolean;
  /** Why this is in the package. */
  readonly reason: string;
}

/** One published package: what it is called, what it holds, what it declares. */
export interface PackageTarget {
  /** The release train this package is on, and the word its tag carries. */
  readonly component: Component;
  /** The name npm publishes it under. */
  readonly name: string;
  /**
   * The file name this package's tarball is published under, at every tag, for
   * ever.
   *
   * Stable and not version-stamped, and that is a constraint rather than a
   * preference. `npm pack` writes `softiesolutions-agentplex-hub-1.2.0.tgz`,
   * and the release workflow renames it on the way up, because GitHub's
   * `releases/latest/download/<asset>` redirect substitutes the tag into the
   * path and copies the file name through verbatim -- so a name carrying a
   * version is a name no unpinned URL can ever be written against. The
   * redirect is not what `install.sh` resolves through any more (see
   * `versions.json`), but a download URL built from a component and a version
   * still needs the third part to be a constant.
   */
  readonly asset: string;
  /** What npm shows on the package page. One sentence, and each one differs. */
  readonly description: string;
  /** Where the assembled tree is written, relative to the workspace root. */
  readonly output: string;
  /**
   * The workspace manifests whose dependency ranges this package declares.
   *
   * One entry for every target here, which is the app the package exists to
   * ship. It is a list because the old single tarball needed three, and because
   * the rule -- what a manifest in the package needs, the published manifest
   * declares -- is the same however many there are.
   */
  readonly declares: readonly string[];
  readonly bundled: readonly BundledPackage[];
  /**
   * Dependencies this package declares optional, by name.
   *
   * See `OPTIONAL_IN_THE_CLI`: one package has an entry and the reason is
   * written out there. Everywhere else this is empty, and for the server that
   * emptiness is the decision rather than the absence of one.
   */
  readonly optional: readonly string[];
  /** The command this package installs, and the file it links. Only one has one. */
  readonly bin?: { readonly command: string; readonly entrypoint: string };
  readonly entries: readonly PackageEntry[];
}

/**
 * node-pty, optional in the CLI package and in no other.
 *
 * node-pty is a native addon with no Linux prebuild, so npm compiles it from
 * source on every Linux install, and that compile is the likeliest step of an
 * install to fail. It reaches a manifest through the bundled `@agentplex/pty`,
 * carried up by the rule that a bundled package's needs are declared by the
 * package that carries it.
 *
 * **The CLI.** It holds the wizard, which opens a terminal to log a provider
 * in, and the doctor, which asks whether one could be opened. Both belong on
 * every machine, hub-only ones included, and a hub-only machine is exactly the
 * one that may have no compiler. Optional is what lets npm finish there: the
 * command installs, `agentplex doctor` reports the pty seam as unusable in so
 * many words, and the wizard's provider login is the one thing that cannot run.
 *
 * **The server.** node-pty is a hard dependency, and that is the whole reason
 * the split is worth doing. Every session a server runs is driven through a
 * pseudoterminal, so a server without one is not a degraded server, it is not a
 * server. npm exits 0 when an *optional* dependency's build fails and removes
 * it from the tree without printing anything -- verified against npm 11.19 --
 * which used to mean a server could report a clean install and then fail to
 * open a session. With the dependency required, npm fails the install itself,
 * at the compile, with node-gyp's own error. That deletes a failure mode rather
 * than guarding against it, and it is what retired AGENTPLEX_REQUIRE_PTY: there
 * is no longer a machine on which a silently skipped node-pty is a lie.
 *
 * **The hub and the client.** Neither bundles `@agentplex/pty`, so node-pty is
 * not in either dependency set at all, optional or otherwise.
 */
const OPTIONAL_IN_THE_CLI: readonly string[] = ['node-pty'];

/** Where a bundled dependency has to sit for Node's resolver to find it. */
function bundledDirectory(name: string): string {
  return `node_modules/${name}`;
}

/**
 * Names a compiled `dist` carries for the workspace and for nothing on a
 * machine that installed the package.
 *
 * **`*.js.map` and `*.d.ts.map`.** `tsc` emits them with `sources` naming
 * `../src/*.ts` and no `sourcesContent`, and no tarball carries the sources, so
 * every one of them resolves to nothing wherever the package is installed. The
 * `sourceMappingURL` comment left in the `.js` is read by nothing unless Node
 * is started with `--enable-source-maps`, and a map it cannot find is a map it
 * does not apply.
 *
 * **`*.d.ts`.** Nothing consumes types from these packages. They are a bin and
 * two daemons, installed to be run and imported by no one, and the `types`
 * conditions the bundled manifests carry are read by TypeScript alone -- never
 * by Node's resolver, which resolves through `import`, `require` and `default`.
 *
 * **`testing.js` and the `fake-*` modules it re-exports.** A package exports
 * its fakes from a `testing` entry for the tests of the packages above it.
 * Every import of one is in a `.test.ts`, which `tsconfig.build.json` excludes
 * from the emit, so no compiled file in a package reaches `./testing` and no
 * test file ships to reach it either. The `./testing` subpath the bundled
 * manifests declare is left where it is: it can only be reached by an import
 * naming it, the packages contain none, and stripping it would be the first
 * half of a job -- the `types` conditions dangle the same way for the same
 * reason -- that buys nothing a resolver would ever notice.
 */
function isWorkspaceOnly(name: string): boolean {
  return (
    name.endsWith('.map') ||
    name.endsWith('.d.ts') ||
    name === 'testing.js' ||
    name.startsWith('fake-')
  );
}

/**
 * The one name `apps/web/dist` carries for a development build and for nothing
 * on an installed machine: the client's source map.
 *
 * `vite.config.ts` asks for it deliberately, and it is worth asking for. Vite
 * writes `sourcesContent` into it, so unlike every compiled map above it
 * resolves with no checkout beside it, and somebody wanted the deployed PWA
 * debuggable. What that cost is the reason it stops here rather than at the
 * build: the map is 3437 KB against the 834 KB bundle it describes -- 57
 * percent of the whole unpacked package -- and every installed machine paid it.
 * The split takes the client off a server machine entirely; this takes the map
 * off the hub machines that do install it. Emitting it and not publishing it
 * keeps the intent where it is exercised, which is a developer running the hub
 * against a local build.
 *
 * The bundle keeps its `sourceMappingURL` comment, and that is a decision.
 * `sourcemap: 'hidden'` would strip the comment at the build, which is the same
 * saving and a worse trade: it would also unhook the map from the local build
 * that is the only reason the map is still emitted. So the comment stays and
 * one request misses. `answerWebAssetRequest` falls back to the shell only for
 * an extensionless path -- the app owns paths, the build owns filenames -- so a
 * `.map` that is not there is a 404 with `text/plain` on it, never `index.html`
 * under a JSON content type, and devtools note the 404 and go on showing the
 * bundle. `web-assets.test.ts` holds that at the origin.
 */
function isClientSourceMap(name: string): boolean {
  return name.endsWith('.map');
}

/** The compiled program an app's package exists to ship. */
function compiledApp(app: string, reason: string): PackageEntry {
  return {
    from: `apps/${app}/dist`,
    to: `apps/${app}/dist`,
    kind: 'directory',
    proof: 'main.js',
    exclude: isWorkspaceOnly,
    reason,
  };
}

/** Every bundled workspace package, at the path Node's resolver reaches it. */
function bundledEntries(bundled: readonly BundledPackage[]): readonly PackageEntry[] {
  return bundled.map((item) => ({
    from: `${item.directory}/dist`,
    to: `${bundledDirectory(item.name)}/dist`,
    kind: 'directory' as const,
    proof: 'index.js',
    exclude: isWorkspaceOnly,
    reason: `the compiled ${item.name}, bundled because it is published nowhere`,
  }));
}

/**
 * The two files every package page needs. The licence is what npm shows beside
 * the package; the README is the page itself, and each package has one of its
 * own because four entries on a registry that all said the same thing would
 * tell a reader nothing about which one they wanted.
 */
function licenceAndReadme(readme: string): readonly PackageEntry[] {
  return [
    {
      from: 'LICENSE',
      to: 'LICENSE',
      kind: 'file',
      reason: 'Apache-2.0, which npm shows on the package page',
    },
    { from: readme, to: 'README.md', kind: 'file', reason: 'the package page' },
  ];
}

/** The postinstall, carried by the packages that carry node-pty with it. */
const POSTINSTALL_ENTRY: PackageEntry = {
  from: POSTINSTALL_SCRIPT,
  to: POSTINSTALL_SCRIPT,
  kind: 'file',
  reason: "the package's postinstall: node-pty's spawn helper, made executable",
};

/**
 * The command, and the two commands inside it.
 *
 * Every role installs this one, because `setup` and `doctor` are how a machine
 * is configured and checked whatever it runs. It carries no daemon: there is no
 * `agentplex hub` to type, and the daemon packages are what a unit names.
 */
export const CLI: PackageTarget = {
  component: 'cli',
  name: CLI_PACKAGE,
  asset: 'agentplex.tgz',
  description: 'The agentplex command: the setup wizard and the read-only doctor',
  output: 'apps/cli/release',
  declares: [BIN_APP],
  bundled: [...SHARED, PTY, RELEASE],
  optional: OPTIONAL_IN_THE_CLI,
  bin: { command: 'agentplex', entrypoint: ENTRYPOINT },
  entries: [
    {
      from: `${BIN_APP}/dist`,
      to: `${BIN_APP}/dist`,
      kind: 'directory',
      proof: 'main.js',
      exclude: isWorkspaceOnly,
      reason: 'the agentplex bin, and its setup and doctor commands',
    },
    POSTINSTALL_ENTRY,
    ...bundledEntries([...SHARED, PTY, RELEASE]),
    ...licenceAndReadme(`${BIN_APP}/README.md`),
  ],
};

/**
 * The hub daemon, and the schema it applies before it listens.
 *
 * No `@agentplex/pty`, which is the whole point: there is nothing in this
 * package's dependency set that reaches node-pty, so a machine installing only
 * a hub compiles nothing and needs no toolchain to install with.
 *
 * The client is not in here either. `apps/hub` declares it as a workspace
 * dependency so that the one specifier resolves in a checkout, but it is a
 * published package of its own, so it is installed beside this one rather than
 * carried inside it -- see `publishedManifest` for what happens to that range.
 */
export const HUB: PackageTarget = {
  component: 'hub',
  name: HUB_PACKAGE,
  asset: 'agentplex-hub.tgz',
  description:
    'The agentplex hub daemon: the database, the paired servers, and the client it serves',
  output: 'apps/hub/release',
  declares: ['apps/hub'],
  bundled: SHARED,
  optional: [],
  entries: [
    compiledApp('hub', 'the compiled hub'),
    {
      from: 'apps/hub/migrations',
      to: 'apps/hub/migrations',
      kind: 'directory',
      proof: '0001_hub_identity.sql',
      reason: 'the schema the hub applies before it listens',
    },
    ...bundledEntries(SHARED),
    ...licenceAndReadme('apps/hub/README.md'),
  ],
};

/**
 * The server daemon, and the one package that needs a pseudoterminal to exist.
 *
 * node-pty is a required dependency here and optional nowhere else. See
 * `OPTIONAL_IN_THE_CLI` for the argument; the short of it is that npm failing
 * the install at the compile is a better outcome than a server that installs
 * cleanly and cannot open a session.
 */
export const SERVER: PackageTarget = {
  component: 'server',
  name: SERVER_PACKAGE,
  asset: 'agentplex-server.tgz',
  description:
    'The agentplex server daemon: sessions through a pty, and the stores on this machine',
  output: 'apps/server/release',
  declares: ['apps/server'],
  bundled: [...SHARED, PTY],
  optional: [],
  entries: [
    compiledApp('server', 'the compiled server'),
    POSTINSTALL_ENTRY,
    ...bundledEntries([...SHARED, PTY]),
    ...licenceAndReadme('apps/server/README.md'),
  ],
};

/**
 * The built PWA, as bytes and nothing else.
 *
 * It is a Vite application in the workspace, and none of that travels: no
 * react, no mantine, no vite. The package holds `dist` and a manifest, the hub
 * resolves the manifest to find the directory, and reads files out of it. That
 * is also why this package declares nothing at all -- see `publishedManifest`,
 * where a target with no manifests to read produces an empty dependency set
 * rather than the client's build-time tree.
 *
 * ## The one package whose layout is the app's rather than the workspace's
 *
 * `dist` sits at this package's root, where every other package here puts its
 * program at `apps/<app>/dist`. That is not an inconsistency somebody forgot to
 * tidy; it is the same rule reaching a different answer, and getting it wrong
 * was caught by installing the packages rather than by reading them.
 *
 * The rule is that a package keeps the layout the code in it resolves against.
 * `apps/hub/dist/main.js` asks for `../migrations`, so everything above it has
 * to look like the workspace or that expression means something else. Nothing
 * in the client resolves anything -- it is bytes a browser is handed. What does
 * resolve is the hub, and what it asks for is "the build beside this manifest":
 * `new URL('./dist', <the client's package.json>)`. In a checkout that manifest
 * is `apps/web/package.json` and the build is `apps/web/dist`, so `./dist` is
 * right; in the image the same two files sit at the same distance for the same
 * reason. Staging the build at `apps/web/dist` inside the package would put the
 * manifest and the build at different distances *here* and nowhere else, which
 * is exactly the artifact-only breakage the layout rule exists to prevent --
 * and it did break, resolving to `<package>/dist` on an installed machine with
 * the files two directories further down.
 */
export const WEB: PackageTarget = {
  component: 'web',
  name: WEB_PACKAGE,
  asset: 'agentplex-web.tgz',
  description: 'The agentplex web app, built: the files the hub serves',
  output: 'apps/web/release',
  declares: [],
  bundled: [],
  optional: [],
  entries: [
    {
      from: 'apps/web/dist',
      to: 'dist',
      kind: 'directory',
      proof: 'index.html',
      // Everything the browser loads, and not the map beside it: see
      // `isClientSourceMap`. One name, so the fonts, the icons, the manifest
      // and the service worker are all still here.
      exclude: isClientSourceMap,
      reason: 'the built PWA the hub serves',
    },
    ...licenceAndReadme('apps/web/README.md'),
  ],
};

/** Every package this release publishes, in the order a machine installs them. */
export const PACKAGES: readonly PackageTarget[] = [CLI, HUB, SERVER, WEB];

/**
 * A workspace dependency naming one of these is a sibling, not a bundle.
 *
 * The hub depends on the client, in the workspace, so that pnpm links it and
 * the hub's one specifier resolves from a checkout. In the published world the
 * client is a package of its own: `install.sh --role=hub` installs it beside
 * the hub, and the hub degrades honestly -- one warning at startup, 503 on the
 * client routes, everything else untouched -- when it is not there.
 *
 * So the range is dropped rather than bundled or declared, and with
 * per-component releases in place that is now a settled answer rather than a
 * wait for one. It was left open on the grounds that it would become a
 * version-pinned dependency once there was a released version to pin. There is
 * one, and it still cannot be expressed. Three reasons, and the third is the
 * one that matters:
 *
 * **Nothing is published to a registry.** Delivery is GitHub Releases, so
 * `"@softiesolutions/agentplex-web": "1.1.0"` names an npm entry that does not
 * exist, and `npm install <hub tarball url>` would fail resolving it -- on
 * every machine, not only on the ones installing from a directory.
 *
 * **A URL dependency would work and is worse.** npm resolves a dependency whose
 * range is an https tarball URL, so the hub *could* declare the client's
 * release URL outright. It would also send the container check -- which
 * installs from a directory of local tarballs precisely so that it tests this
 * build -- out to the network for the client, and fail on a machine with no
 * route to github.com.
 *
 * **The hub does not know which client is current, and must not.** A tag
 * releases one component; `versions.json` is written afterwards, by a later
 * job. So a version written in here would have to be one the hub was built
 * against, frozen into every hub artifact for ever -- which is exactly the
 * coupling the split removed. `agentplex update web` exists as an idea because
 * a client can be replaced without a new hub, and a pinned dependency is the
 * one way to make that impossible.
 *
 * The relationship stays stated by the role table in `install.sh`, and that
 * statement is stronger than it was: the two are resolved from one manifest,
 * checked against each other's protocol before either is downloaded, and
 * installed in one npm invocation, so a machine ends up with the pair or with
 * neither. The hub still degrades honestly if somebody removes the client
 * afterwards -- one warning at startup, 503 on the client routes, health and
 * the websocket untouched.
 */
const PUBLISHED_NAMES: ReadonlySet<string> = new Set(PACKAGES.map((target) => target.name));

/**
 * A `cp` filter that drops files by name and never prunes a directory.
 *
 * `cp` asks the filter about every entry it walks, directories included, and a
 * `false` for a directory takes everything beneath it as well -- verified
 * against Node 24.20. So a name test alone would turn a directory called
 * `fake-parent` into a missing program, which is why the directory is
 * established first and only files are ever refused.
 */
function copyFilter(exclude: (name: string) => boolean): (source: string) => Promise<boolean> {
  return async (source: string): Promise<boolean> => {
    if ((await lstat(source)).isDirectory()) return true;
    return !exclude(basename(source));
  };
}

/**
 * As much of a package.json as this needs to be sure of. Unknown fields are
 * kept out of the type and off the derived manifest: what a package declares
 * is decided here, not inherited by accident.
 */
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  license: z.string(),
  type: z.literal('module'),
  engines: z.record(z.string(), z.string()).optional(),
  repository: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
});

export type Manifest = z.infer<typeof manifestSchema>;

/**
 * A package.json read off disk is external input like anything else, so it goes
 * through a parser that can say no rather than through a cast.
 */
export function parseManifest(source: string, text: string): Manifest {
  const parsed = manifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${source} is not a manifest this can publish: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Every version this can publish, as semver.org writes it: three numeric parts
 * with no leading zeroes, an optional prerelease, an optional build.
 *
 * Written out rather than pulled from a package, because it is read once per
 * release and a dependency whose install script runs on a machine holding a
 * publish token is a worse trade than a regular expression with a citation.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** What a release tag says: which component is being released, and at what. */
export interface ReleaseTag {
  readonly component: Component;
  readonly version: string;
}

/**
 * The component and the version a release tag names.
 *
 * It was `versionFromTag` and it answered one question, because a release was
 * one build of four packages at one version. A release is now one component's,
 * so the tag has to say which -- `hub-v1.2.0` -- and the name moved with the
 * second answer rather than leaving a function called `versionFromTag`
 * returning a component.
 *
 * Nothing in this workspace carries a version: every manifest says `0.0.0` and
 * no script bumps one, because a version in a manifest is a second place the
 * release lives and the day it disagrees with the tag, the tarball published
 * and the commit it claims to come from are different things. The tag is the
 * single statement of what is being released, and this is the one reader of it.
 *
 * The tag is an argument out of another program, so it is parsed rather than
 * trusted, and both halves can say no. A tag the workflow's `*-v*` filter
 * admits but this does not -- a `hub-v1.2`, a `cli-vlatest`, a
 * `bogus-v1.0.0` -- stops the release with the tag quoted, instead of
 * assembling a component nobody has and publishing it under a version nobody
 * can install by the range they meant. The tag is quoted because the failures
 * that reach here are the ones where the exact bytes matter: a trailing space
 * and an empty component are both invisible in an unquoted message.
 */
export function releaseFromTag(tag: string): ReleaseTag {
  // The first `-v` and not the last. No component's name holds one, and a
  // prerelease identifier may: `cli-v1.0.0-v.1` splits at the first and is a
  // release of the CLI, where splitting at the last would name a component
  // called `cli-v1.0.0` and refuse a tag that is perfectly well formed.
  const marker = tag.indexOf('-v');
  if (marker <= 0) {
    throw new Error(`a release tag is \`<component>-v<semver>\`, and this one is "${tag}"`);
  }
  const component = tag.slice(0, marker);
  const version = tag.slice(marker + 2);
  const target = PACKAGES.find((candidate) => candidate.component === component);
  if (target === undefined) {
    throw new Error(
      `"${tag}" names no component of this release: expected one of ` +
        `${PACKAGES.map((candidate) => candidate.component).join(', ')}`,
    );
  }
  if (!SEMVER.test(version)) {
    throw new Error(`a release tag is \`<component>-v<semver>\`, and this one is "${tag}"`);
  }
  return { component: target.component, version };
}

/**
 * The manifest a package is published with.
 *
 * Derived from the workspace's rather than written twice: a hand-kept copy is a
 * second place the dependency ranges live, and the day they disagree the
 * package installs a `ws` that nothing here was tested against.
 *
 * What is decided rather than inherited.
 *
 * **`private` is gone, and `devDependencies` never arrive.** Every workspace
 * manifest is private precisely so that a stray `npm publish` in a checkout
 * cannot ship it. A publishable manifest is made here, in a staging directory
 * that holds no sources, so the thing that can be published is the thing that
 * was assembled.
 *
 * **A `workspace:` range becomes a bundled dependency, unless it names another
 * published package.** No workspace package is published under a name of its
 * own except the four this module assembles, so a range pointing at a registry
 * entry would otherwise be a dependency on a package that does not exist. Each
 * one travels inside the tarball instead, at the one path Node's resolver
 * reaches from the compiled program above it, and a bundled package's own
 * workspace dependencies have to be bundled too, since the resolver walks up
 * out of one bundled directory into the next. A range naming a sibling package
 * is dropped: see `PUBLISHED_NAMES`.
 *
 * **What a bundled package needs, the published package declares.** npm treats
 * every dependency of a bundled dependency as bundled too and never fetches it,
 * so `bundledManifest` drops the field and the ranges are carried up here
 * instead. One range per dependency name, across every manifest that goes in:
 * nothing takes precedence over anything, and two manifests asking for
 * different ranges of the same thing stop the assembly, because a tarball
 * cannot carry both and picking one silently would ship a dependency that one
 * of them was never tested against.
 *
 * **The version comes from the release, not from the manifest.** Every manifest
 * in the workspace says `0.0.0`, deliberately. `version` is the seam the
 * release writes through, so the manifest is built with the released version
 * rather than assembled and then edited -- an edit is a step between what was
 * checked and what is published, and there is nowhere for one to go wrong if it
 * does not exist. Without an override this falls back to the app's manifest,
 * which is what a contributor assembling locally wants: the same `0.0.0` the
 * workspace says.
 *
 * **The name and the description are the target's, and there is no
 * `publishConfig`.** The unscoped `agentplex` on npm is an unrelated
 * placeholder, so everything here is published under the scope, and a `bin` key
 * is not a package name -- the command stays `agentplex` in the one package
 * that installs one. Four packages need four descriptions, so those are stated
 * per target rather than taken from the workspace root, which has one. A scoped
 * package's first publish needs `--access public`, and the release workflow
 * passes it on the command line; declaring it here as well would be the same
 * fact in two places.
 *
 * **`engines` keeps node and drops pnpm.** The whole point of these artifacts
 * is a machine with Node and nothing else; declaring pnpm would make a package
 * refuse the machine it was built for.
 *
 * **`agentplex.protocol` is the one field npm has no opinion about, and it is
 * the point of the whole per-component release.** `PROTOCOL_VERSION` is the
 * single compatibility constant in this repository, and this epic reads it as
 * the version of everything `packages/protocol` declares -- the wire frames and
 * the on-disk formats whose schemas live beside them alike. Four components on
 * four release trains are safe exactly while they agree on it.
 *
 * Written here rather than asserted anywhere, because a machine cannot check a
 * claim that exists only in a workflow. The assembly runs after `pnpm build`,
 * so the constant it reads is the compiled one the programs in this very
 * tarball import -- not a number copied into a YAML file that drifts the first
 * time somebody bumps one and forgets the other. Once it is in the manifest it
 * is a fact about the artifact: `install.sh` pre-checks it before a pinned
 * install, the release publishes it into `versions.json`, and `status` and
 * `doctor` can read it back off an installed machine and say that the hub and
 * the server on it no longer speak.
 *
 * Under `agentplex` rather than at the top level, and not called
 * `protocolVersion`. npm ignores unknown fields but the root of a manifest is
 * shared with every tool that reads one, and one namespaced object is a place
 * the next such fact can go without a second decision.
 *
 * **The `postinstall` follows node-pty.** It is declared by the two packages
 * that carry `@agentplex/pty` and by neither of the others. node-pty ships
 * prebuilt binaries for macOS and Windows, the npm tarball drops the executable
 * bit from the `spawn-helper` beside them, and the only symptom is
 * `posix_spawnp failed.` out of a native addon for a session that never starts.
 */
export function publishedManifest(input: {
  readonly target: PackageTarget;
  readonly root: Manifest;
  /** The workspace manifests the target names, in that order. */
  readonly manifests: readonly Manifest[];
  readonly bundled: readonly Manifest[];
  /** The version the release names. Absent outside a release. */
  readonly version?: string;
}): Record<string, unknown> {
  const { target } = input;
  const versions = new Map(input.bundled.map((manifest) => [manifest.name, manifest.version]));
  const dependencies: Record<string, string> = {};
  const optional: Record<string, string> = {};
  const declaredBy = new Map<string, string>();
  const bundleDependencies = new Set<string>();

  // The target's own manifests first, then each bundled package. The order
  // decides nothing but which manifest an error names as the incumbent: there
  // is one range per dependency name across all of them, and a disagreement
  // stops the assembly rather than resolving to a winner.
  for (const manifest of [...input.manifests, ...input.bundled]) {
    for (const name of Object.keys(manifest.dependencies).sort()) {
      const range = manifest.dependencies[name] ?? '';
      if (range.startsWith('workspace:')) {
        if (PUBLISHED_NAMES.has(name)) continue;
        const version = versions.get(name);
        if (version === undefined) {
          throw new Error(
            `${name} is a workspace dependency of ${manifest.name} and ${target.name} does not bundle it`,
          );
        }
        // Exact, not a range: the copy in the tarball is the only copy there
        // will ever be, so a range would describe a choice npm does not get to
        // make.
        dependencies[name] = version;
        bundleDependencies.add(name);
        continue;
      }
      // An optional dependency is carried up the same way and lands in a
      // different field. The name is what decides, and it is decided per
      // package: node-pty is an ordinary dependency of `packages/pty`, which is
      // correct -- a checkout that cannot compile it cannot run its tests --
      // and only the CLI has a reason to let npm continue without it.
      const into = target.optional.includes(name) ? optional : dependencies;

      const existing = into[name];
      if (existing === undefined) {
        into[name] = range;
        declaredBy.set(name, manifest.name);
        continue;
      }
      // npm never fetches a bundled package's own dependencies: `zod` declared
      // by a bundled package while the tarball carries no `node_modules/zod`
      // installs as an empty directory, and the first import dies with
      // ERR_MODULE_NOT_FOUND from a package npm says is installed. Verified
      // against npm 11.19. So the range is carried up here, and one range per
      // name is the invariant that keeps carrying it up honest.
      if (existing !== range && !bundleDependencies.has(name)) {
        throw new Error(
          `${manifest.name} needs ${name}@${range} and ${declaredBy.get(name) ?? target.name} ` +
            `needs ${name}@${existing}: one range, declared in both manifests, or ${target.name} ` +
            'ships a dependency one of them was never tested against',
        );
      }
    }
  }

  const node = input.root.engines?.['node'];
  if (node === undefined) throw new Error('the root manifest declares no node engine');
  const carriesPostinstall = target.entries.some((entry) => entry.from === POSTINSTALL_SCRIPT);

  return {
    name: target.name,
    version: input.version ?? input.manifests[0]?.version ?? input.root.version,
    description: target.description,
    license: input.root.license,
    ...(input.root.repository === undefined ? {} : { repository: input.root.repository }),
    type: 'module',
    engines: { node },
    agentplex: { protocol: PROTOCOL_VERSION },
    ...(target.bin === undefined
      ? {}
      : { bin: { [target.bin.command]: `./${target.bin.entrypoint}` } }),
    // A staging directory holds only what belongs in the package, so this
    // changes nothing about what npm packs. It is here so that the contents are
    // legible from the manifest -- and reviewable in a diff to it -- without
    // running `npm pack`. A bundled dependency is not listed: npm always
    // excludes `node_modules` from a tarball and then adds the bundled subtrees
    // back, and `files` has no say either way.
    files: target.entries
      .map((entry) => entry.to)
      .filter((path) => !path.startsWith('node_modules/')),
    ...(carriesPostinstall ? { scripts: { postinstall: `node ${POSTINSTALL_SCRIPT}` } } : {}),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
    optionalDependencies: Object.fromEntries(Object.entries(optional).sort()),
    bundleDependencies: [...bundleDependencies].sort(),
  };
}

/**
 * What `exports` is allowed to hold.
 *
 * Node resolves a subpath to a string, to a `null` that refuses it, to an array
 * of alternatives, or to a map of conditions holding more of the same, nested
 * as deep as a package cares to nest it. This is carried across untouched, so
 * the schema describes that shape and flattens nothing: a type that stopped one
 * level down would either reject the conditional exports every package here
 * writes or quietly drop what it could not name, and either way the bundled
 * directory is one the resolver cannot enter.
 */
export type ExportsEntry =
  string | null | readonly ExportsEntry[] | { readonly [condition: string]: ExportsEntry };

const exportsSchema: z.ZodType<ExportsEntry> = z.lazy(() =>
  z.union([z.string(), z.null(), z.array(exportsSchema), z.record(z.string(), exportsSchema)]),
);

/**
 * Exactly the fields a bundled package is extracted with. Everything else a
 * workspace manifest carries is dropped by parsing it away, and an optional
 * field the source never declared is absent from the result rather than present
 * and undefined, so the object and the JSON written from it say the same thing.
 */
const bundledManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  type: z.literal('module'),
  sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
  exports: exportsSchema.optional(),
  main: z.string().optional(),
  types: z.string().optional(),
});

export type BundledManifest = z.infer<typeof bundledManifestSchema>;

/**
 * The manifest a bundled package is extracted with.
 *
 * Its `exports` is what makes the bundled directory resolvable, so that is
 * carried across untouched. Everything that only means something inside a
 * workspace -- `private`, the scripts, the dev dependencies -- is dropped,
 * because a consumer's npm reads this file and none of it is true there.
 *
 * `dependencies` is dropped too, and that one is not tidying. npm considers a
 * bundled package's dependencies bundled as well and will not fetch them, so a
 * declaration the tarball does not satisfy installs an empty directory: `npm
 * ls` reports `zod@ invalid`, the install exits 0, and the first import fails
 * with ERR_MODULE_NOT_FOUND against a package npm believes is present. The
 * protocol's needs are declared by the package that carries it -- see the guard
 * in `publishedManifest` -- and Node's resolver walks up out of the bundled
 * directory to find them, which is the same walk it does in the workspace.
 *
 * `bundledManifestSchema` is the whole of what survives, so what a bundled
 * package declares is decided here rather than inherited: an unreadable source
 * stops the assembly with its path named, and a field nobody listed cannot
 * reach a consumer's npm by accident.
 */
export function bundledManifest(source: string, text: string): BundledManifest {
  const parsed = bundledManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${source} is not a manifest this can bundle: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** A source the assembly needs and did not find. */
export interface MissingInput {
  readonly path: string;
  readonly reason: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every input that is not there, rather than the first one.
 *
 * Somebody who has not built the workspace is missing most of these, and one
 * message per run would send them round the loop once per file.
 */
export async function missingInputs(
  workspaceRoot: string,
  entries: readonly PackageEntry[],
): Promise<readonly MissingInput[]> {
  const missing: MissingInput[] = [];
  for (const entry of entries) {
    const source = join(workspaceRoot, entry.from);
    if (!(await exists(source))) {
      missing.push({ path: entry.from, reason: entry.reason });
      continue;
    }
    if (entry.proof !== undefined && !(await exists(join(source, entry.proof)))) {
      missing.push({ path: join(entry.from, entry.proof), reason: entry.reason });
    }
  }
  return missing;
}

export interface AssembledPackage {
  readonly target: PackageTarget;
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * Write one package into `<workspaceRoot>/<target.output>`, replacing whatever
 * was there.
 *
 * Replacing rather than merging: a staging directory that keeps yesterday's
 * `dist` beside today's is the one way to publish a file no build produced.
 */
export async function assemblePackage(options: {
  readonly target: PackageTarget;
  readonly workspaceRoot: string;
  /** The version the release names; see `publishedManifest`. Absent outside a release. */
  readonly version?: string;
  readonly log?: (line: string) => void;
}): Promise<AssembledPackage> {
  const { target, workspaceRoot } = options;
  const log = options.log ?? ((): void => {});

  const missing = await missingInputs(workspaceRoot, target.entries);
  if (missing.length > 0) {
    const lines = missing.map((item) => `  ${item.path} -- ${item.reason}`);
    throw new Error(
      `nothing to package for ${target.name}; run \`pnpm build\` first:\n${lines.join('\n')}`,
    );
  }

  if (target.bin !== undefined) {
    const entrypoint = target.bin.entrypoint;
    if (!(await readFile(join(workspaceRoot, entrypoint), 'utf8')).startsWith('#!')) {
      throw new Error(
        `${entrypoint} has no shebang, so \`bin\` would link a file the kernel hands to the shell`,
      );
    }
  }

  const read = async (path: string): Promise<string> =>
    await readFile(join(workspaceRoot, path), 'utf8');
  const rootManifest = parseManifest('package.json', await read('package.json'));
  const bundled = await Promise.all(
    target.bundled.map(async (item) => {
      const path = `${item.directory}/package.json`;
      const text = await read(path);
      return { item, path, text, manifest: parseManifest(path, text) };
    }),
  );
  const manifests = await Promise.all(
    target.declares.map(async (directory) => {
      const path = `${directory}/package.json`;
      return parseManifest(path, await read(path));
    }),
  );

  const manifest = publishedManifest({
    target,
    root: rootManifest,
    manifests,
    bundled: bundled.map((entry) => entry.manifest),
    ...(options.version === undefined ? {} : { version: options.version }),
  });

  const directory = join(workspaceRoot, target.output);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  for (const entry of target.entries) {
    const destination = join(directory, entry.to);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(workspaceRoot, entry.from), destination, {
      recursive: entry.kind === 'directory',
      ...(entry.exclude === undefined ? {} : { filter: copyFilter(entry.exclude) }),
    });
    log(`    ${entry.to}  ${entry.reason}`);
  }

  for (const entry of bundled) {
    await writeJson(
      join(directory, bundledDirectory(entry.item.name), 'package.json'),
      bundledManifest(entry.path, entry.text),
    );
  }
  await writeJson(join(directory, 'package.json'), manifest);

  return { target, directory, manifest };
}

/**
 * All four, from one build at the workspace's own version.
 *
 * This is the contributor's path and the container check's: a directory of
 * tarballs from one build, which `AGENTPLEX_PACKAGE` installs and no tag
 * names. A release assembles one component -- see `main`.
 *
 * Assembled in order rather than in parallel so that the log reads as a list of
 * packages: the work is a few hundred file copies and the wall clock is not
 * what anybody is waiting on here.
 */
export async function assemblePackages(options: {
  readonly workspaceRoot: string;
  readonly version?: string;
  readonly log?: (line: string) => void;
}): Promise<readonly AssembledPackage[]> {
  const assembled: AssembledPackage[] = [];
  for (const target of PACKAGES) {
    options.log?.(`${target.name}`);
    assembled.push(await assemblePackage({ ...options, target }));
  }
  return assembled;
}

/**
 * Where a release's loose files go: the metadata asset, and the description of
 * the release the workflow reads back.
 *
 * Beside the staging directories rather than inside one. Everything in
 * `apps/<app>/release` is packed into the tarball, and neither of these belongs
 * inside the package they describe.
 */
export const RELEASE_ASSETS = 'release-assets';

/**
 * The small JSON published beside a tarball at every tag, carrying that
 * release's protocol.
 *
 * It exists for one case, and it is the case the whole grammar is about:
 * `install.sh --role=hub@1.3.0` has to know what protocol 1.3.0 speaks
 * *before* it installs anything. `versions.json` cannot answer it -- that file
 * describes what is current, and a pin is by definition a request for
 * something else -- and reading the protocol out of the tarball means
 * downloading and unpacking the tarball, which is the half-installed machine
 * this is trying to prevent.
 *
 * The cost is one more small file per release. What it buys is that a pinned
 * set that cannot talk to itself is refused with both numbers named and nothing
 * written to the disk, rather than found when a hub and a server that are both
 * installed and both running decline to pair.
 */
export interface ReleaseMetadata {
  readonly component: Component;
  readonly version: string;
  readonly protocol: number;
}

/** The metadata asset's name, which is its tarball's with the suffix swapped. */
export function metadataAsset(target: PackageTarget): string {
  return `${target.asset.replace(/\.tgz$/, '')}.json`;
}

/**
 * Everything the release workflow needs to know about what was just assembled,
 * written to a file rather than printed.
 *
 * The workflow used to read the package name and the version back out of each
 * assembled manifest, which was right when the only questions were "what is it
 * called" and "at what version". A per-component release also has to know which
 * directory to pack, what to rename the tarball to, and what to call the
 * metadata beside it -- and every one of those is a fact this module already
 * holds. A file the workflow reads with the same `node -p` it already uses
 * keeps them here, where the tag was parsed, instead of turning the workflow
 * into a second place that knows how a component maps to a directory.
 */
export interface ReleaseDescription extends ReleaseMetadata {
  readonly package: string;
  /** Relative to the workspace root. */
  readonly directory: string;
  readonly asset: string;
  readonly metadataAsset: string;
}

export function releaseDescription(target: PackageTarget, version: string): ReleaseDescription {
  return {
    component: target.component,
    version,
    protocol: PROTOCOL_VERSION,
    package: target.name,
    directory: target.output,
    asset: target.asset,
    metadataAsset: metadataAsset(target),
  };
}

/**
 * One component, at the version its tag names, plus the loose files the release
 * publishes beside its tarball.
 */
export async function assembleRelease(options: {
  readonly workspaceRoot: string;
  readonly tag: string;
  readonly log?: (line: string) => void;
}): Promise<{ readonly assembled: AssembledPackage; readonly release: ReleaseDescription }> {
  const { component, version } = releaseFromTag(options.tag);
  const target = PACKAGES.find((candidate) => candidate.component === component);
  // `releaseFromTag` has already refused every component that is not one of
  // these, so this is unreachable -- and it is here rather than as a `!`
  // because the two lists agreeing is what makes it unreachable, and a cast
  // would be the assertion that they always will.
  if (target === undefined) throw new Error(`no package assembles the ${component} component`);

  options.log?.(`${target.name}`);
  const assembled = await assemblePackage({ ...options, target, version });
  const release = releaseDescription(target, version);

  const assets = join(options.workspaceRoot, RELEASE_ASSETS);
  await rm(assets, { recursive: true, force: true });
  const metadata: ReleaseMetadata = { component, version, protocol: release.protocol };
  await writeJson(join(assets, release.metadataAsset), metadata);
  await writeJson(join(assets, 'release.json'), release);

  return { assembled, release };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Run from the workspace root, after `pnpm build`. It writes directories and
 * nothing more: publishing is a separate, deliberate command aimed at the trees
 * this leaves behind.
 *
 * The one argument is the release tag, which the workflow passes as
 * `pnpm --filter ./scripts package "$GITHUB_REF_NAME"` and a contributor passes
 * never. With it, one component is assembled at the version the tag names and
 * `release-assets/` is written beside it. Without it, all four are assembled at
 * the workspace's own `0.0.0` -- assembleable, installable from a directory of
 * tarballs, and publishable nowhere, which is exactly the distinction between a
 * local check and a release.
 */
async function main(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
  const log = (line: string): void => void process.stdout.write(`${line}\n`);
  const tag = process.argv[2];

  if (tag !== undefined) {
    const { assembled, release } = await assembleRelease({ workspaceRoot, tag, log });
    log(
      `assembled the ${release.component} component, ${release.package}@${release.version}, ` +
        `speaking protocol ${release.protocol}, into ${relative(workspaceRoot, assembled.directory)}`,
    );
    log(`wrote ${RELEASE_ASSETS}/${release.metadataAsset} and ${RELEASE_ASSETS}/release.json`);
    return;
  }

  const assembled = await assemblePackages({ workspaceRoot, log });
  for (const item of assembled) {
    log(
      `assembled ${String(item.manifest['name'])}@${String(item.manifest['version'])} ` +
        `into ${relative(workspaceRoot, item.directory)}`,
    );
  }
}

// Imported by its test; executed by `pnpm --filter ./scripts package`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
