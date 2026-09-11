import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

/**
 * Everything this package does to node-pty at install time: check that it can
 * be loaded, and restore the executable bit on its `spawn-helper`.
 *
 * ## The check
 *
 * node-pty is an optional dependency of the published package. It ships no
 * Linux prebuild, so npm compiles it from source on every Linux install, and
 * the hub -- which never opens a pseudoterminal -- was paying for a C++
 * toolchain and that compile to install a program it does not run.
 *
 * The price of optional is that npm exits 0 when the build fails, removes the
 * package from the tree, and prints nothing about it. Verified against npm
 * 11.19: an optional dependency whose install script exits 1 leaves an install
 * that says `up to date` and a `node_modules` with no such directory in it. For
 * a hub that is exactly right. For a server it is the silent success this file
 * exists to prevent, so the machine that is going to run a server says so, and
 * this refuses the install rather than handing over a binary that cannot open a
 * session.
 *
 * It says so through AGENTPLEX_REQUIRE_PTY, which `install.sh` sets for
 * `--role=server` and `--role=both` and leaves unset for `--role=hub`. A
 * variable rather than AGENTPLEX_ROLE, which the same script writes into the
 * settings file: this one asks a single question with a single answer, and it
 * cannot be set by accident in a contributor's shell in a way that fails their
 * next `pnpm install`.
 *
 * Without it this warns and exits 0. A hand-typed `npm install --global` on a
 * machine with no compiler is a hub install as far as anything here can tell,
 * and the two programs that need a pty refuse to pretend otherwise on their
 * own: an agentplex server will not start, and `agentplex doctor` reports the
 * seam as unusable.
 *
 * Loading and not resolving, which is the distinction the whole check turns on.
 * `require.resolve` succeeds against a node-pty whose sources arrived and whose
 * addon was never built -- the shape an `ignore-scripts` install leaves behind
 * -- and the first thing that would notice is a session that never starts.
 *
 * ## The repair
 *
 * node-pty does not exec the child itself on Unix: it forks a tiny helper
 * binary that sets up the controlling terminal and then execs. The npm tarball
 * carries that helper without its executable bit — verified against
 * node-pty@1.1.0, whose `prebuilds/darwin-arm64/spawn-helper` unpacks as
 * `rw-r--r--` — and node-pty's own `postinstall` does not chmod it; it cleans
 * the release folder and moves a Windows DLL.
 *
 * The reason that is a script and not a comment somewhere is the failure mode.
 * A helper without the bit does not produce a permission error naming a file.
 * It produces `Error: posix_spawnp failed.` from inside a native addon, with no
 * path, no errno and no stack below the binding — for a session that simply
 * never starts. Anybody meeting that for the first time reasonably concludes
 * the native module is broken and starts rebuilding toolchains.
 *
 * The repair is idempotent, and silent unless it changes something: on a
 * machine where the bit survived (a source build through node-gyp sets it) this
 * prints nothing. It never fails an install on its own either. An install that
 * stopped because a chmod was unavailable would be a worse outcome than the
 * spawn failure it exists to prevent, and the integration test is what actually
 * proves a PTY can be opened here.
 */

const HELPER = 'spawn-helper';
const EXECUTABLE = 0o755;
/** Set by `install.sh` for a role that runs a server, and by nothing else. */
const REQUIRED = 'AGENTPLEX_REQUIRE_PTY';
/** node-pty is wanted here and is not usable. The install must not report success. */
const EXIT_NO_PTY = 1;

const require = createRequire(import.meta.url);

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
 * node-pty as this package resolves it, loaded rather than located, and the
 * directory it came out of.
 *
 * The store path holds a content hash and a version, and the app is not always
 * the only thing linking to it. Asking the resolver is the one way to reach the
 * copy that will actually be loaded at runtime.
 */
function loadNodePty() {
  try {
    require('node-pty');
    // The package's main entry, whose directory's parent is the package root.
    return { root: dirname(dirname(require.resolve('node-pty'))), problem: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { root: null, problem: message.split('\n')[0] ?? 'it could not be loaded' };
  }
}

function restoreSpawnHelper(root) {
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

function main() {
  const { root, problem } = loadNodePty();
  if (root !== null) {
    restoreSpawnHelper(root);
    return;
  }

  const advice =
    'node-pty ships no Linux prebuild and is compiled at install time by python3, make and a ' +
    'C++ compiler; an npm configured with ignore-scripts skips that build entirely.';

  if (process.env[REQUIRED] === undefined || process.env[REQUIRED] === '') {
    // A hub, or an install nobody told. Both are machines this package has no
    // reason to stop, and the two programs that need a pty refuse on their own.
    console.warn(
      `node-pty: not usable here (${problem}), so this machine cannot run an agentplex server. ` +
        `${advice} A hub needs none of it.`,
    );
    return;
  }

  console.error(`node-pty: not usable here: ${problem}`);
  console.error(
    `${REQUIRED} is set, so this machine is meant to run an agentplex server, and every ` +
      'session a server runs is driven through a pseudoterminal. ' +
      advice,
  );
  process.exit(EXIT_NO_PTY);
}

main();
