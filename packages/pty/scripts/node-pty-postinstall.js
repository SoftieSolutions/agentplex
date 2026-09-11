import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Everything this package does to node-pty at install time: check that it can
 * be loaded, and restore the executable bit on its `spawn-helper`.
 *
 * ## The check, and what it stopped being
 *
 * This used to be able to fail an install, and AGENTPLEX_REQUIRE_PTY was how
 * `install.sh` asked it to. That existed because node-pty was an *optional*
 * dependency of one tarball that every machine installed: npm exits 0 when an
 * optional dependency's build fails, removes the package from the tree and
 * prints nothing -- verified against npm 11.19 -- so a server could report a
 * clean install and then fail to open a session. The variable was the last
 * thing that could still turn that into a failure.
 *
 * The release is four packages now, and node-pty is a required dependency of
 * `@softiesolutions/agentplex-server`. npm fails that install itself, at the
 * compile, with node-gyp's own error naming the compiler -- so the silent
 * success this file was guarding against cannot happen on the machine it
 * mattered on, and a variable that arranged for a second way to fail the same
 * install is machinery with no reason left. It is gone rather than left
 * standing.
 *
 * What is left is a warning. `@softiesolutions/agentplex` -- the command, which
 * every role installs -- keeps node-pty optional, because a hub-only machine
 * may have no compiler and should still get `setup` and `doctor`. There, a
 * node-pty that did not build is a true and survivable state: the wizard's
 * provider login is what cannot run, `agentplex doctor` reports the seam as
 * unusable, and an agentplex server refuses to start at all. So this says so
 * and exits 0, on the machine where that is the honest answer.
 *
 * Loading and not resolving, which is the distinction the check turns on.
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

  // Reachable from the command package, where node-pty is optional, and from a
  // hand-typed install on a machine with no compiler. Both are machines this
  // package has no business stopping: the programs that need a pty refuse on
  // their own, and the server package is the one where npm has already refused.
  console.warn(
    `node-pty: not usable here (${problem}), so this machine cannot run an agentplex server ` +
      'and `agentplex setup` cannot log a provider in through a terminal. node-pty ships no ' +
      'Linux prebuild and is compiled at install time by python3, make and a C++ compiler; an ' +
      'npm configured with ignore-scripts skips that build entirely. A hub needs none of it.',
  );
}

main();
