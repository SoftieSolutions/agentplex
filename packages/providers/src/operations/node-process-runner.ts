import { execFile, spawn } from 'node:child_process';
import type { DetachedSpawner, DetachedStart } from './detached-spawn.js';
import type { Argv } from './operation.js';
import type { ProcessOutcome, ProcessRequest, ProcessRunner } from './process-runner.js';

/**
 * The real one-shot spawn, and the only place in agentplex that imports
 * `node:child_process`. Lint enforces the "only": see `eslint.config.js`.
 *
 * Everything dangerous about starting a process is decided here, once, where
 * there is no request-shaped input to be influenced by:
 *
 * - `shell: false` is written down rather than defaulted. `execFile` already
 *   defaults to it, but a default is a thing that changes and a thing readers
 *   have to remember; with it spelled out, turning it on is a visible edit to
 *   this file rather than an option someone passes from somewhere else.
 * - No `cwd`, ever. The child inherits agentplex's own directory and every
 *   directory an operation cares about is in its argv. A caller therefore
 *   cannot relocate a child, and `git -C` is the only reason git looks anywhere
 *   but here.
 * - The environment is fixed at construction. `main` passes `process.env`; a
 *   test passes a literal. Nothing an operation is asked to do can add a
 *   variable, because no type between here and the wire has a place for one.
 *
 * `maxBuffer` and the per-operation timeout are the two ways a child can cost
 * more than it is worth, and both end as a `failed` outcome rather than a
 * rejected promise: a program that hangs is a fact the caller has to report,
 * not an exception for it to unwind through.
 *
 * The detached spawner at the bottom of this file is the other way a child is
 * started, and it is here rather than in a module of its own precisely so that
 * the lint rule above can stay absolute: one file imports `node:child_process`,
 * and a second exception would be the beginning of a list. It makes the same
 * three decisions in the same place -- no shell, no cwd, the environment fixed
 * at construction -- and differs only in what happens after the fork.
 */

/**
 * A megabyte of output, which is orders of magnitude more than any operation
 * here produces and still bounded. `git status` in a repository with a hundred
 * thousand untracked files is the case this exists for: the answer would be
 * useless and the memory is not ours to spend.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface NodeProcessRunnerDependencies {
  /**
   * The environment children get, decided once and never per request. Values
   * may be `undefined` because `process.env` says they may be.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function createNodeProcessRunner({
  environment,
}: NodeProcessRunnerDependencies): ProcessRunner {
  return {
    async run(request: ProcessRequest): Promise<ProcessOutcome> {
      return new Promise<ProcessOutcome>((resolve) => {
        execFile(
          request.file,
          [...request.args],
          {
            shell: false,
            env: environment,
            timeout: request.timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
            // Nothing here is interactive, and a console window flashing up on
            // a machine somebody is using is a bug they cannot diagnose.
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ kind: 'exited', exitCode: 0, stdout, stderr });
              return;
            }

            // A program that ran and exited nonzero: `code` is the exit status,
            // and what it means is the operation's call, not this file's. Its
            // output is passed on intact — git says why in its stderr.
            const code = exitCodeOf(error);
            if (code !== null) {
              resolve({ kind: 'exited', exitCode: code, stdout, stderr });
              return;
            }

            // Everything else is the machine saying no: nothing started
            // (`ENOENT` for a program that is not installed), or what started
            // was killed by the timeout or by exceeding the output cap.
            resolve({ kind: 'failed', problem: describeFailure(request, error) });
          },
        );
      });
    },
  };
}

/**
 * The exit status, when there was one.
 *
 * `execFile` reports a nonzero exit and a failure to spawn through the same
 * error object, distinguished only by whether `code` is a number: `1` from a
 * `ps` that found no such pid, `'ENOENT'` from a `git` that is not installed.
 * Reading it as a claim rather than casting it is the difference between "the
 * program answered no" and "there is no program".
 */
function exitCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function describeFailure(request: ProcessRequest, error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; killed?: unknown };
    // Both of these kill the child, so `killed` alone cannot tell them apart,
    // and they are different problems to whoever reads the message: one is a
    // program that would not finish, the other one that would not stop talking.
    if (record.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return `${request.file} wrote more than ${MAX_OUTPUT_BYTES} bytes and was killed`;
    }
    if (record.killed === true) {
      return `${request.file} did not finish within ${request.timeoutMs}ms and was killed`;
    }
  }
  return `${request.file} could not be run: ${String(error)}`;
}

/**
 * The real detached start: fork it, hand it nothing, and let go.
 *
 * Three things are deliberate, and each of them is what makes the update notice
 * able to ask for a refresh without the command an operator typed paying for
 * one.
 *
 * - **`detached: true`** puts the child in a process group of its own. Without
 *   it a `^C` at the operator's terminal reaches the whole foreground group, so
 *   the refresh this started would be killed by the keystroke that ended the
 *   command it was started from -- which is the one moment somebody is most
 *   likely to press it.
 * - **`stdio: 'ignore'`** is what keeps the child's output out of the parent's
 *   report and, less obviously, what keeps the parent from being held open: an
 *   inherited pipe is a handle the event loop counts, so a child writing to one
 *   would keep this process alive until it finished, which is exactly the wait
 *   this exists to avoid. It is also why the child sees no terminal and prints
 *   no notice of its own.
 * - **`unref()`** releases the handle libuv keeps for the child itself. With
 *   the two above and without this, the parent still waits.
 *
 * The error listener is not optional. A failure to spawn -- `ENOENT` for an
 * interpreter that is not there -- is delivered as an `error` event on the
 * child object, and an `error` event with no listener is thrown as an uncaught
 * exception. The whole point of this call is that it cannot cost the command
 * that made it anything, so the one failure mode it has must not be able to end
 * the process.
 *
 * What comes back is whether the fork happened, and never what the child did.
 * That is not a limitation of the implementation, it is the seam: nothing here
 * waits, so nothing here can know.
 */
export function createNodeDetachedSpawner({
  environment,
}: NodeProcessRunnerDependencies): DetachedSpawner {
  return {
    async start(argv: Argv): Promise<DetachedStart> {
      return new Promise<DetachedStart>((resolve) => {
        let child;
        try {
          child = spawn(argv.file, [...argv.args], {
            shell: false,
            env: environment,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (error) {
          // `spawn` itself throws for an argument it will not accept -- a file
          // name with a NUL in it -- rather than emitting an error event.
          resolve({ ok: false, problem: `${argv.file} could not be started: ${String(error)}` });
          return;
        }

        child.once('error', (error: Error) => {
          resolve({ ok: false, problem: `${argv.file} could not be started: ${String(error)}` });
        });

        // `spawn` is asynchronous, so a child that will fail with ENOENT has
        // not failed yet at this point. `spawned` is emitted when the fork
        // succeeded, which is the only moment this can honestly answer yes.
        child.once('spawn', () => {
          child.unref();
          resolve({ ok: true });
        });
      });
    },
  };
}
