import {
  describeProcessRequest,
  type ProcessOutcome,
  type ProcessRequest,
  type ProcessRunner,
} from './process-runner.js';

/**
 * A process table a test writes down: argv in, captured output back.
 *
 * A real implementation of the seam rather than a mock, for the reason every
 * other fake here is one. What matters about an operation is what it does with
 * the output a program actually produced — a `git status` in a directory that
 * is not a repository, a `ps` that will not report a pid — and those are values
 * this can return. Asserting that `run` was called would test the code's shape
 * instead of its judgement.
 *
 * It does record every request, because there is one assertion about shape that
 * is load-bearing: what argv an operation built. A directory that reached a
 * child as `-C <dir>` rather than as a spawn cwd is visible only in the argv.
 */
export interface FakeProcessRunnerOptions {
  /**
   * Answers keyed by `describeProcessRequest` — the file and its arguments,
   * joined by spaces. A key is a lookup, never a command: nothing here splits
   * it back apart or runs it.
   */
  readonly outcomes?: Readonly<Record<string, ProcessOutcome>>;
  /**
   * The answer for an argv with no entry. The default says the program is not
   * there, which is the honest answer for a machine that has never heard of it
   * and keeps a test from silently passing on an argv it did not mean to build.
   */
  readonly fallback?: ProcessOutcome;
}

export interface FakeProcessRunner extends ProcessRunner {
  /** Every request made, in order, exactly as the operation built it. */
  readonly requests: readonly ProcessRequest[];
}

export function createFakeProcessRunner(options: FakeProcessRunnerOptions = {}): FakeProcessRunner {
  const outcomes = new Map(Object.entries(options.outcomes ?? {}));
  const requests: ProcessRequest[] = [];

  return {
    requests,

    async run(request: ProcessRequest): Promise<ProcessOutcome> {
      requests.push(request);
      return (
        outcomes.get(describeProcessRequest(request)) ??
        options.fallback ?? {
          kind: 'failed',
          problem: `no such program: ${request.file}`,
        }
      );
    },
  };
}

/** The successful run of a program that printed `stdout` and nothing else. */
export function printed(stdout: string): ProcessOutcome {
  return { kind: 'exited', exitCode: 0, stdout, stderr: '' };
}

/** A program that ran and said no: git's 128, ps's 1. */
export function refused(exitCode: number, stderr: string): ProcessOutcome {
  return { kind: 'exited', exitCode, stdout: '', stderr };
}
