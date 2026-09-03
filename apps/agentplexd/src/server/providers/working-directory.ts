import { isAbsolute, relative, resolve } from 'node:path';
import type { StoreDescriptor } from '@agentplex/protocol';

/**
 * Where a session is allowed to run, and the answer the provider seam deferred.
 *
 * The seam shipped without a working directory on purpose: the store path is
 * not one. For Claude Code a store is the config directory that v1 hardwired as
 * `~/.claude`, and launching an agent with that as its cwd would point it at the
 * provider's own state — the one place the spec forbids agentplex to write.
 * So a cwd has to come from somewhere else, and there are exactly two somewheres:
 *
 * - **Starting a session**: the caller supplies it, and it is validated here.
 *   Note what "the caller" is not. No frame carries a cwd — the spec is explicit
 *   and the reason is that a `{ cwd }` field on the wire is a remote code
 *   execution primitive wearing a path: whoever holds a client token picks any
 *   directory on the server and runs an agent with write access to it. What
 *   crosses the wire names a store; the server turns that into a directory from
 *   its own configuration, and this function is the gate that answer passes.
 * - **Resuming a session**: the directory the session already had, read out of
 *   the provider's own transcript by discovery. Not a choice anybody gets to
 *   make: a session resumed somewhere else is a different session that happens
 *   to share a history, and every relative path in that history now means
 *   something else.
 *
 * Both go through the same parser, because a path out of a transcript is a
 * claim off disk exactly as much as one out of a request.
 */
export type WorkingDirectory =
  { readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly problem: string };

/**
 * `null` is a real input: it is what discovery reports for a session whose
 * provider never recorded where it ran, and the honest answer is a refusal
 * rather than a guess at the store, the home directory, or wherever agentplexd
 * happens to have been started.
 */
export function parseWorkingDirectory(
  candidate: string | null,
  store: StoreDescriptor,
): WorkingDirectory {
  if (candidate === null || candidate.trim() === '') {
    return { ok: false, problem: 'this session has no working directory to run in' };
  }

  // A NUL truncates the path at the syscall, so the directory that gets opened
  // is a prefix of the one that was checked. Nothing legitimate carries one.
  if (candidate.includes('\0')) {
    return { ok: false, problem: 'a working directory may not contain a null byte' };
  }

  if (!isAbsolute(candidate)) {
    return {
      ok: false,
      problem:
        `a working directory must be an absolute path, and ${candidate} is not: ` +
        'a relative one would resolve against whatever directory agentplexd was started in',
    };
  }

  // Resolved, not merely checked: `/a/b/../../etc` is absolute and is `/etc`,
  // and the containment test below has to run on what the kernel will use.
  const cwd = resolve(candidate);
  const storeRoot = resolve(store.path);

  if (cwd === storeRoot || contains(storeRoot, cwd)) {
    return {
      ok: false,
      problem:
        `${cwd} is inside the store at ${storeRoot}: a store holds a provider's own state, ` +
        'and an agent started there would be editing the transcripts agentplex reads',
    };
  }

  return { ok: true, cwd };
}

/** Whether `child` is under `parent`, by path segments rather than by string prefix. */
function contains(parent: string, child: string): boolean {
  const step = relative(parent, child);
  // `..` anywhere in the first segment means it climbed out, and an absolute
  // result means the two share no root at all (a Windows drive letter).
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}
