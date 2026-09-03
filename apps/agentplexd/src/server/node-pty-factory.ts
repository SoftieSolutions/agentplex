import { spawn } from 'node-pty';
import type { Pty, PtyExit, PtyFactory, PtyRequest } from './pty.js';

/**
 * The real pseudoterminal, through node-pty.
 *
 * Two things about this dependency are worth knowing before touching it.
 *
 * It is a native addon, and on Unix it does not exec the child itself: it forks
 * a small `spawn-helper` binary that acquires the controlling terminal and then
 * execs. The npm tarball ships that helper without its executable bit, and the
 * only symptom is `Error: posix_spawnp failed.` thrown out of the binding with
 * no path, no errno and nothing below it in the stack — for a session that
 * simply never starts. `scripts/fix-node-pty-permissions.js` restores the bit
 * at install, and the package is in `allowBuilds` so that it runs at all.
 *
 * And its `onData` is typed `IEvent<string>` while `encoding: null` makes it
 * deliver `Buffer`. The typing is wrong rather than the runtime: the option
 * exists precisely to stop node-pty decoding, and decoding is what must not
 * happen here. A pty read lands wherever the kernel splits it, which is
 * regularly the middle of a UTF-8 code point and regularly the middle of an
 * escape sequence; decoding each read on its own replaces both with U+FFFD and
 * there is no getting them back. So the seam is bytes, and `toBytes` below
 * accepts what the types claim as well as what actually arrives.
 */
export const nodePtyFactory: PtyFactory = {
  open(request: PtyRequest): Pty {
    const terminal = spawn(request.command, [...request.args], {
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
