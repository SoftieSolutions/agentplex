import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  parseVersionsManifest,
  serializeVersionsManifest,
  updateVersionsManifest,
} from '@agentplex/release';

/**
 * `node versions-manifest.ts <component> <version> <protocol> [<previous>]`,
 * printing the merged manifest on stdout.
 *
 * The three values come from the release job, which read them back out of the
 * manifest it assembled -- so the protocol here is the compiled constant the
 * published tarball itself declares, not a number typed into a workflow. The
 * previous manifest is a path rather than stdin so that a failure to produce it
 * is a missing file with a name in the error, rather than an empty pipe that
 * reads as "there was nothing there".
 *
 * What this file is *not* is the schema. That moved to `@agentplex/release`,
 * because `agentplex update` reads the same file off the network and two
 * TypeScript parsers for one format are two ways to disagree about what a
 * machine should install. `apps/cli` cannot import from here -- this directory
 * is dev tooling and ships nothing -- so the one place both may name is a
 * package, and this is now the release job's entrypoint into it and nothing
 * else.
 *
 * The cost is one build in the `v1` job, which used to install this directory
 * alone and run straight away. It is the smallest build in the workspace:
 * `@agentplex/release` depends on zod and on nothing in the workspace, so the
 * job that publishes the version oracle still does not wait on the hub, the
 * server or the protocol compiling.
 */
async function main(): Promise<void> {
  const [component, version, protocol, previousPath] = process.argv.slice(2);
  if (component === undefined || version === undefined || protocol === undefined) {
    throw new Error('usage: versions-manifest.ts <component> <version> <protocol> [<previous>]');
  }

  const previous =
    previousPath === undefined
      ? {}
      : parseVersionsManifest(previousPath, await readFile(previousPath, 'utf8'));

  const manifest = updateVersionsManifest(previous, component, {
    version,
    protocol: Number(protocol),
  });
  process.stdout.write(serializeVersionsManifest(manifest));
}

// Executed by the release workflow's `v1` job. The schema it merges through is
// tested in the package that owns it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
