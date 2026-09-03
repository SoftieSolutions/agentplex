import { z } from 'zod';
import type { CompletedProcess } from './process-runner.js';
import type { Operation, OperationOutcome } from './operation.js';

/**
 * When the process now holding this pid began, on a platform that answers with
 * `ps`.
 *
 * This operation exists because the spawn it replaces was already in the tree.
 * `node-process-probe` reached for `execFile` directly to date a pid on macOS,
 * which is a small and entirely reasonable-looking thing to do — and it is
 * exactly how "every spawn goes through the registry" stops being true. A rule
 * with one exception has none, so the exception is gone: the probe now runs
 * this, and `node:child_process` is lint-forbidden everywhere but the runner.
 *
 * That also makes the registry load-bearing on day one rather than a shape
 * waiting for milestone 3 to give it a caller. Dating a pid is the check that
 * keeps a provider's stale registry entry from being reported as a running
 * session, so this operation is on the path of every discovery pass.
 *
 * Why `ps` at all: on Linux the probe reads `/proc`, which needs no child at
 * all and works in a container that ships no `ps`. macOS has no `/proc` and
 * Node cannot call `sysctl`, so `ps -o lstart=` is what is left.
 */
export interface ProcessStartTime {
  /** Epoch ms, as `ps` dated it in the machine's own zone. */
  readonly startedAt: number;
}

/**
 * A pid, and only the kind of pid that means one process.
 *
 * 0 and negatives are rejected here rather than at the child, because they mean
 * something else entirely to a kernel — the caller's process group, and a group
 * by id — and a probe that dated "the group" would be answering a question
 * nobody asked. Integer, because `ps -p 1.5` is a different conversation.
 */
export const processStartTimeRequestSchema = z.strictObject({ pid: z.int().positive() });
export type ProcessStartTimeRequest = z.infer<typeof processStartTimeRequestSchema>;

export const processStartTimeOperation: Operation<ProcessStartTimeRequest, ProcessStartTime> = {
  name: 'process.start-time',
  summary: 'The moment the process now holding a pid began, where ps can say',
  request: processStartTimeRequestSchema,

  // `lstart=` with the trailing `=` is the column header suppressed: the output
  // is the date and nothing else, so nothing has to skip a header line.
  argv: ({ pid }) => ({ file: 'ps', args: ['-p', String(pid), '-o', 'lstart='] }),

  /**
   * Two seconds. `ps` on a single pid is immediate; a `ps` that hangs is a
   * wedged process table, and the discovery pass this sits inside must not
   * inherit that wait once per session.
   */
  timeoutMs: 2_000,

  read: readStartTime,
};

function readStartTime(
  completed: CompletedProcess,
  { pid }: ProcessStartTimeRequest,
): OperationOutcome<ProcessStartTime> {
  // A pid `ps` will not report is a pid that cannot be dated. It exits 1 and
  // says nothing at all, on either stream, so there is no message to forward.
  if (completed.exitCode !== 0) {
    return { ok: false, refusal: 'failed', problem: `ps will not report pid ${pid}` };
  }

  // Local time, and parsed as such. `ps` prints the moment in the machine's own
  // zone with no marker on it — unlike the `procStart` string Claude Code
  // writes into its own registry, which is the same format rendered in UTC and
  // lands hours off when read as local. That is why nothing reads that field
  // and everything dates a process here.
  const startedAt = Date.parse(completed.stdout.trim());
  if (Number.isNaN(startedAt)) {
    return {
      ok: false,
      refusal: 'failed',
      problem: `ps dated pid ${pid} in a format this cannot read`,
    };
  }

  return { ok: true, result: { startedAt } };
}
