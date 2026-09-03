import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProcessProbe } from './process-probe.js';

const run = promisify(execFile);

/**
 * The real process table, per platform, with no native dependency.
 *
 * Liveness is signal 0: the kernel's own answer to "does this pid exist", and
 * the only one that cannot be raced by a listing. `EPERM` counts as alive —
 * the process is there, it simply is not ours, which is the normal case for a
 * server that did not spawn the agent it is watching.
 *
 * Dating a process is where the platforms part, and the split is not a
 * preference:
 *
 * - Linux reads `/proc`. The deployment image is `node:24-bookworm-slim`, which
 *   ships no `ps` at all, so a `ps`-based implementation would return `null`
 *   for every pid in production while passing every test on a developer's Mac —
 *   status derivation silently disabled exactly where it runs. `/proc` is part
 *   of the kernel, needs no package, and dates a process to ~10ms.
 * - macOS has no `/proc`, and Node cannot call `sysctl`. `ps -o lstart=` is the
 *   remaining answer, spawned as argv with no shell.
 *
 * Anything else answers `null`, and `null` is honest: a caller that cannot date
 * a pid must not treat it as proof of anything.
 */
export const nodeProcessProbe: ProcessProbe = {
  async isAlive(pid: number): Promise<boolean> {
    if (!isPid(pid)) return false;
    try {
      // Signal 0 checks for the process without delivering anything to it.
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Alive, but owned by another user. "Not mine" is not "not there", and
      // reading it as absence would drop every session a server watches
      // without having spawned it.
      return errorCode(error) === 'EPERM';
    }
  },

  async startedAt(pid: number): Promise<number | null> {
    if (!isPid(pid)) return null;
    if (process.platform === 'linux') return procStartedAt(pid);
    if (process.platform === 'darwin') return psStartedAt(pid);
    return null;
  },
};

/**
 * The `/proc` route: boot time plus the process's own offset from it.
 *
 * `/proc/<pid>/stat` records `starttime` in clock ticks since boot, and
 * `/proc/stat` records `btime`, the boot moment in epoch seconds. Their sum is
 * an absolute date that no timezone touches.
 *
 * Two details bite. The second field is the executable name in parentheses and
 * may itself contain spaces and parentheses, so the fields are counted from the
 * *last* `)` rather than by splitting the line. And the tick is `USER_HZ`,
 * fixed at 100 by the kernel's `/proc` ABI whatever `CONFIG_HZ` a distribution
 * builds with — `sysconf(_SC_CLK_TCK)`, which Node cannot call, would return
 * the same 100.
 */
const USER_HZ = 100;

async function procStartedAt(pid: number): Promise<number | null> {
  const stat = await readTextFile(`/proc/${pid}/stat`);
  if (stat === null) return null;

  const comm = stat.lastIndexOf(')');
  if (comm === -1) return null;
  // Field 22 overall; the two before it are the pid and the parenthesised name.
  const ticks = numberAt(
    stat
      .slice(comm + 1)
      .trim()
      .split(/\s+/),
    19,
  );
  if (ticks === null) return null;

  const boot = await bootedAt();
  return boot === null ? null : boot + (ticks / USER_HZ) * 1000;
}

/** Epoch ms of the last boot, read fresh: a cached one would outlive a reboot. */
async function bootedAt(): Promise<number | null> {
  const stat = await readTextFile('/proc/stat');
  if (stat === null) return null;

  for (const line of stat.split('\n')) {
    if (!line.startsWith('btime ')) continue;
    const seconds = Number(line.slice('btime '.length).trim());
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  return null;
}

/**
 * The macOS route: `ps` prints the start moment in the local zone.
 *
 * Local, and therefore parseable — unlike the `procStart` string Claude Code
 * writes into its own registry, which is the same format rendered in UTC with
 * no zone marker and silently lands hours off when read as local time. That is
 * why nothing here reads that field and everything dates a process itself.
 */
async function psStartedAt(pid: number): Promise<number | null> {
  try {
    // argv, never a shell string, and `pid` is a verified integer besides.
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2_000 });
    const started = Date.parse(stdout.trim());
    return Number.isNaN(started) ? null : started;
  } catch {
    // A pid `ps` will not report is a pid we cannot date, which is the same
    // answer as a platform that cannot date anything.
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** A field read out of another program's output is a claim, not a number. */
function numberAt(fields: readonly string[], index: number): number | null {
  const field = fields[index];
  if (field === undefined) return null;
  const value = Number(field);
  return Number.isFinite(value) ? value : null;
}

/** Guards `process.kill`, whose meaning changes for 0 and for negatives. */
function isPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
