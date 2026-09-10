import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProgramResolver } from './program-resolver.js';

/**
 * The real search, against a real disk.
 *
 * It answers the same question the kernel will answer at the spawn, in the same
 * order, and it is deliberately the *only* thing here that is clever: first
 * directory holding a regular file that this process may execute wins. Anything
 * more -- following a shim to what it eventually runs, reading a wrapper -- would
 * be this file guessing at what a spawn does, and a preflight whose answer
 * differs from the spawn's is worse than none.
 *
 * The check is `X_OK` on the effective user, so a directory of files nobody may
 * run supplies nothing, which is what the spawn will find too. It is a regular
 * file rather than any entry, because a directory named `claude` on a PATH is
 * not a program and reporting it as one would name a directory that no spawn
 * will ever resolve from.
 *
 * POSIX-shaped, like the rest of the spawn path here: no PATHEXT, no `.cmd`.
 * The pty seam already runs on `spawn-helper`, so the platform this is honest
 * about is the platform agentplex runs on.
 */
export function createNodeProgramResolver(searchPath: readonly string[]): ProgramResolver {
  return {
    async resolve(name: string): Promise<string | null> {
      for (const directory of searchPath) {
        if (await holdsProgram(directory, name)) return directory;
      }
      return null;
    },
  };
}

/**
 * Whether one directory holds a runnable program by that name.
 *
 * Every failure is a no rather than a throw. A PATH entry that does not exist,
 * one on a network mount that is not responding, one whose mode bits keep this
 * process out: all of them supply no program, and none of them may stop the
 * directories after them from being asked. That is the same rule an unreadable
 * store follows -- it costs itself and not the listing.
 */
async function holdsProgram(directory: string, name: string): Promise<boolean> {
  const candidate = join(directory, name);
  try {
    // Both, and in this order. `access` alone would accept an executable
    // directory, which every directory on a PATH is; `stat` alone would accept
    // a file this process may read and never run.
    const entry = await stat(candidate);
    if (!entry.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
