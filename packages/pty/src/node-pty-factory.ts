import { createRequire } from 'node:module';
import type * as NodePty from 'node-pty';
import type { Pty, PtyExit, PtyFactory, PtyRequest } from './pty.js';

/**
 * The real pseudoterminal, through node-pty.
 *
 * Three things about this dependency are worth knowing before touching it.
 *
 * It is a native addon, and on Unix it does not exec the child itself: it forks
 * a small `spawn-helper` binary that acquires the controlling terminal and then
 * execs. The npm tarball ships that helper without its executable bit, and the
 * only symptom is `Error: posix_spawnp failed.` thrown out of the binding with
 * no path, no errno and nothing below it in the stack — for a session that
 * simply never starts. `scripts/node-pty-postinstall.js` restores the bit at
 * install, and the package is in `allowBuilds` so that it runs at all.
 *
 * And its `onData` is typed `IEvent<string>` while `encoding: null` makes it
 * deliver `Buffer`. The typing is wrong rather than the runtime: the option
 * exists precisely to stop node-pty decoding, and decoding is what must not
 * happen here. A pty read lands wherever the kernel splits it, which is
 * regularly the middle of a UTF-8 code point and regularly the middle of an
 * escape sequence; decoding each read on its own replaces both with U+FFFD and
 * there is no getting them back. So the seam is bytes, and `toBytes` below
 * accepts what the types claim as well as what actually arrives.
 *
 * And it is loaded when it is used, not when this module is. node-pty is an
 * optional dependency of the published package, because it has no Linux
 * prebuild and a hub — which never opens a pseudoterminal — was otherwise
 * paying for a C++ toolchain and a source build to install a program it does
 * not run. Optional means npm finishes and exits 0 when that build is skipped
 * or fails, so on a machine where everything else arrived the module can be
 * absent, or present as sources with no `build/Release/pty.node` beside them.
 *
 * A top-level `import { spawn } from 'node-pty'` would turn that absence into
 * an error thrown while the server's `main.js` was still being linked: before
 * `main` runs, before a line of ours is reached, naming a file nobody has heard
 * of. So node-pty is reached through `createRequire` at the moment it is
 * wanted, and `checkNodePty` is the question a program asks before it claims to
 * be starting.
 */

/**
 * node-pty itself, named by its own types rather than restated here.
 *
 * A type-only import, which `tsc` erases: nothing in the emitted JavaScript
 * names node-pty except the `require` below, which is the point of the whole
 * arrangement.
 */
export type NodePtyModule = typeof NodePty;

/**
 * How node-pty is reached.
 *
 * A parameter rather than a module-level constant because the interesting case
 * is the one a test cannot arrange: a machine where the addon is not there. The
 * failure is injected rather than mocked, and `checkNodePty` is the same
 * function in the test and on the machine.
 */
export type NodePtyLoader = () => NodePtyModule;

/**
 * node-pty, as this package resolves it.
 *
 * `createRequire` from this module walks up to `packages/pty/node_modules` in a
 * checkout and to the published package's own `node_modules` in an install,
 * which is the same walk the resolver would have done for a static import. It
 * is synchronous because node-pty is CommonJS, and `require` caches, so calling
 * this per session costs a map lookup after the first.
 */
const requireFromHere = createRequire(import.meta.url);

export const loadNodePty: NodePtyLoader = () =>
  // `require` answers `any`, and there is no parser that can be run against a
  // native addon. The assertion is here, once, rather than at each call.
  requireFromHere('node-pty') as NodePtyModule;

/**
 * Whether this machine can open a pseudoterminal at all, and what is wrong when
 * it cannot.
 *
 * A discriminated pair rather than a boolean and a nullable string: the problem
 * exists exactly when there is one, and the type is what makes a caller that
 * prints nothing impossible to write.
 */
export type PtyAvailability =
  { readonly usable: true } | { readonly usable: false; readonly problem: string };

/**
 * What to do about a node-pty that will not load, written once.
 *
 * It lives here because this is the package that declares node-pty; the server
 * and the doctor both print it, and an operator who meets it in one place and
 * then the other should not be reading two different pieces of advice about the
 * same addon. It names no package and no registry: the two failures it covers —
 * a build with no compiler to run, and an npm configured not to run builds at
 * all — are facts about node-pty, and the install command is the README's to
 * spell.
 */
export const NODE_PTY_REMEDY =
  'node-pty is a native addon and ships no Linux prebuild, so it is compiled at install time ' +
  'by python3, make and a C++ compiler -- and an npm configured with ignore-scripts skips that ' +
  'build entirely. Install those three, then install agentplex again with --ignore-scripts=false.';

/**
 * Ask node-pty to load, and say what happened.
 *
 * Loading and not resolving, which is the whole point. `require.resolve`
 * succeeds against a node-pty whose sources arrived and whose addon was never
 * built — the shape an `ignore-scripts` install leaves behind — and the first
 * thing that would notice is a session that never starts.
 */
export function checkNodePty(load: NodePtyLoader = loadNodePty): PtyAvailability {
  try {
    load();
    return { usable: true };
  } catch (error) {
    return { usable: false, problem: `node-pty could not be loaded: ${reason(error)}` };
  }
}

/** What went wrong, without the stack: an operator is being told, not debugged at. */
function reason(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error);
}

export const nodePtyFactory: PtyFactory = {
  open(request: PtyRequest): Pty {
    const terminal = loadNodePty().spawn(request.command, [...request.args], {
      name: request.term,
      cwd: request.cwd,
      // A copy, because node-pty writes TERM into the object it is handed and
      // deletes TERMCAP from it. The supervisor's record is not its to edit.
      env: { ...request.env },
      cols: request.cols,
      rows: request.rows,
      // The point of the whole seam: raw bytes, never decoded.
      encoding: null,
    });

    return {
      pid: terminal.pid,

      onData(listener: (chunk: Uint8Array) => void): void {
        terminal.onData((chunk) => listener(toBytes(chunk)));
      },

      onExit(listener: (exit: PtyExit) => void): void {
        // node-pty reports 0 for "no signal"; `null` is the honest shape for
        // "it exited on its own", and the supervisor's callers read it that way.
        terminal.onExit(({ exitCode, signal }) =>
          listener({ exitCode, signal: signal === undefined || signal === 0 ? null : signal }),
        );
      },

      write(input: string): void {
        terminal.write(input);
      },

      resize(cols: number, rows: number): void {
        terminal.resize(cols, rows);
      },

      kill(): void {
        terminal.kill();
      },
    };
  },
};

/**
 * What arrived, as bytes.
 *
 * With `encoding: null` this is always a `Buffer`, which is a `Uint8Array`. The
 * string branch is for the typing being what it is: if a future node-pty
 * decodes anyway, `binary` re-encodes byte for byte, which loses nothing that
 * has not already been lost rather than mangling it a second time.
 */
function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
}
