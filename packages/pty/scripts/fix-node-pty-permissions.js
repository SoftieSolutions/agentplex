import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Restore the executable bit on node-pty's `spawn-helper`.
 *
 * node-pty does not exec the child itself on Unix: it forks a tiny helper
 * binary that sets up the controlling terminal and then execs. The npm tarball
 * carries that helper without its executable bit — verified against
 * node-pty@1.1.0, whose `prebuilds/darwin-arm64/spawn-helper` unpacks as
 * `rw-r--r--` — and node-pty's own `postinstall` does not chmod it; it cleans
 * the release folder and moves a Windows DLL.
 *
 * The reason this is a script and not a comment somewhere is the failure mode.
 * A helper without the bit does not produce a permission error naming a file.
 * It produces `Error: posix_spawnp failed.` from inside a native addon, with no
 * path, no errno and no stack below the binding — for a session that simply
 * never starts. Anybody meeting that for the first time reasonably concludes
 * the native module is broken and starts rebuilding toolchains.
 *
 * Idempotent, and silent unless it changes something: on a machine where the
 * bit survived (a source build through node-gyp sets it) this prints nothing
 * and exits 0. It never fails the install either. An install that stops because
 * a chmod is unavailable would be a worse outcome than the spawn failure it
 * exists to prevent, and the integration test is what actually proves a PTY can
 * be opened here.
 */

const HELPER = 'spawn-helper';
const EXECUTABLE = 0o755;

/** Every directory node-pty may have put a helper in, prebuilt or compiled. */
function helperDirectories(root) {
  const directories = [join(root, 'build', 'Release')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(prebuilds, entry.name));
    }
  }
  return directories;
}

/**
 * node-pty as this package resolves it, rather than a guess at pnpm's layout.
 *
 * The store path holds a content hash and a version, and the app is not always
 * the only thing linking to it. Asking the resolver is the one way to reach the
 * copy that will actually be loaded at runtime.
 */
function nodePtyRoot() {
  const require = createRequire(import.meta.url);
  try {
    // The package's main entry, whose directory's parent is the package root.
    return dirname(dirname(require.resolve('node-pty')));
  } catch {
    return null;
  }
}

function main() {
  const root = nodePtyRoot();
  // Not installed, or installed without its scripts. Either way there is
  // nothing here to repair, and saying so on every install of every unrelated
  // workspace would be noise.
  if (root === null) return;

  for (const directory of helperDirectories(root)) {
    const helper = join(directory, HELPER);
    if (!existsSync(helper)) continue;

    try {
      const mode = statSync(helper).mode & 0o777;
      if ((mode & 0o111) !== 0) continue;
      chmodSync(helper, EXECUTABLE);
      console.log(`node-pty: restored the executable bit on ${helper}`);
    } catch (error) {
      // A read-only store, a helper owned by another user. Warn and continue:
      // the next install may be the one that can fix it, and refusing to
      // finish would take the whole workspace down over one file mode.
      console.warn(`node-pty: could not make ${helper} executable: ${String(error)}`);
    }
  }
}

main();
