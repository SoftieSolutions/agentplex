import {
  describeProcessRequest,
  type ProcessOutcome,
  type ProcessRequest,
  type ProcessRunner,
} from '../server/operations/process-runner.js';

/**
 * A machine that changes when something is installed on it.
 *
 * `createFakeProcessRunner` answers one argv with one outcome forever, which is
 * the right seam for an operation that reads output and the wrong one for the
 * property this ticket exists to hold: replaying a plan must leave the machine
 * in the same state, and "the same state" is only observable on a machine whose
 * state can change. Here `claude --version` says the program is not there,
 * an install runs, and `claude --version` starts answering — which is what makes
 * the second replay's decision to adopt rather than install a real decision
 * rather than a table entry a test wrote.
 *
 * The alternative considered and rejected was a runner that returns a *sequence*
 * of answers per argv. That encodes the implementation's call order into the
 * test, so a reordering of two probes fails a test that has no opinion about
 * order, and it cannot express the thing that actually matters — that the second
 * install is a second install.
 *
 * Every byte it hands back is supplied by the test, which is where the captured
 * fixtures are read. Nothing in here writes output on a program's behalf.
 */

export interface FakeInstaller {
  /**
   * The argv that installs something, as `describeProcessRequest` renders it.
   * A lookup and never a command: nothing here splits it back apart or runs it.
   */
  readonly argv: string;
  /** What the installer prints when it puts something there. */
  readonly first: ProcessOutcome;
  /**
   * What it prints when asked again for what is already there. npm's own answer
   * to this is a `change` rather than an `add`, which is precisely the case a
   * reconciling setup hits most and the one a hand-written fixture would miss.
   */
  readonly again: ProcessOutcome;
  /** What the machine can run once this installer has run. */
  readonly programs: Readonly<Record<string, ProcessOutcome>>;
}

export interface FakeMachineOptions {
  /**
   * What this machine can already run, keyed by argv. The default answer for an
   * argv that is not here says the program is not installed, which is the honest
   * answer for a machine that has never heard of it.
   */
  readonly programs?: Readonly<Record<string, ProcessOutcome>>;
  readonly installers?: readonly FakeInstaller[];
}

export interface FakeMachine extends ProcessRunner {
  /** Every request made, in order, exactly as an operation built it. */
  readonly requests: readonly ProcessRequest[];
  /** Every install that actually ran, in order. The count is the whole test. */
  readonly installs: readonly string[];
}

export function createFakeMachine(options: FakeMachineOptions = {}): FakeMachine {
  const programs = new Map(Object.entries(options.programs ?? {}));
  const installers = new Map((options.installers ?? []).map((one) => [one.argv, one]));
  const requests: ProcessRequest[] = [];
  const installs: string[] = [];

  return {
    requests,
    installs,

    async run(request: ProcessRequest): Promise<ProcessOutcome> {
      requests.push(request);
      const argv = describeProcessRequest(request);

      const installer = installers.get(argv);
      if (installer !== undefined) {
        const already = installs.includes(argv);
        installs.push(argv);
        for (const [program, outcome] of Object.entries(installer.programs)) {
          programs.set(program, outcome);
        }
        return already ? installer.again : installer.first;
      }

      return programs.get(argv) ?? { kind: 'failed', problem: `no such program: ${request.file}` };
    },
  };
}
