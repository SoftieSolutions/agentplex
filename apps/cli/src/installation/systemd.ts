import {
  runOperation,
  type CompletedProcess,
  type Operation,
  type OperationOutcome,
  type ProcessRunner,
  type ProgramResolver,
} from '@agentplex/providers';
import { z } from 'zod';
import type { UnitScope } from './layout.js';

/**
 * `systemctl`, as the only thing `agentplex start`, `stop` and `status` do to a
 * machine.
 *
 * ## Why this wraps systemd rather than replacing it
 *
 * The CLI must not run a daemon as its own child. A process supervised by a
 * command an operator typed dies when their shell does, is not restarted when
 * it crashes, does not come back after a reboot, and has nowhere to put a log --
 * and a second, worse supervisor beside the one every Linux box already has is
 * not a thing to build by accident. So these commands enable, start, stop and
 * ask; the thing that runs the daemon is the thing that was always going to run
 * it. What `agentplex start` buys is not supervision, it is that nobody has to
 * remember which `systemctl` reaches their units.
 *
 * ## Every spawn is an operation
 *
 * Six operations, through the registry's own `runOperation`: a parser that can
 * say no, a pure argv builder, and a reader that gives the exit code its
 * meaning. Nothing here builds a command line by concatenating a string, and
 * there is no shell, because `ProcessRequest` has nowhere to put one.
 *
 * The parser is not ceremony. `units` is the one field with anything in it that
 * came from outside this module -- the unit file names a daemon table produced,
 * and eventually whatever a later command lets an operator name -- and the
 * schema below refuses anything that is not `agentplex-<word>.service`. That is
 * what keeps a `--now`, a `--root=/`, or a path from arriving where a unit name
 * belongs, in a command line that is about to enable something.
 *
 * ## The scope is carried, never inferred
 *
 * `uninstall_units` in the installer picks its `systemctl` off `UNIT_SCOPE`,
 * which came out of the same branch that chose the unit directory. Every
 * operation here takes the scope for the same reason: the unit file name is
 * identical in both scopes, so a request that did not carry it would be a
 * request about a unit that might be either.
 */

/**
 * A unit name this may act on.
 *
 * Anchored, and deliberately narrower than systemd's own grammar: these
 * commands act on agentplex's units and nothing else, and a schema that
 * accepted any valid unit name would accept every unit on the machine.
 */
const unitNameSchema = z
  .string()
  .regex(/^agentplex-[a-z][a-z0-9-]*\.service$/, 'not one of agentplex units');

const scopeSchema = z.enum(['user', 'system']);

const unitsRequestSchema = z.object({
  scope: scopeSchema,
  units: z.array(unitNameSchema).min(1),
});

const scopeRequestSchema = z.object({ scope: scopeSchema });

export type UnitsRequest = z.infer<typeof unitsRequestSchema>;

/** The program, which is a name and never a path. */
const SYSTEMCTL = 'systemctl';

/**
 * Reloading is fast, asking is nearly free, and `enable --now` starts a service
 * and waits for the job. Twenty seconds for the two that only talk to the
 * manager, a minute for the one that starts something: a `Type=simple` unit's
 * start job completes as soon as the fork does, so a minute is not a budget, it
 * is the point past which the manager itself is what is wrong.
 */
const ASK_TIMEOUT_MS = 20_000;
const ACT_TIMEOUT_MS = 60_000;

/**
 * The properties one `show` asks for, which is everything `status` prints about
 * a unit.
 *
 * One call rather than the three `is-active`, `is-enabled` and a timestamp would
 * take, and it is not only cheaper: three calls are three moments, so a unit
 * that stopped between the first and the second would be reported as active and
 * disabled, a state it never was in. `show` also exits 0 for a unit the manager
 * has never loaded, where `is-active` exits 3 -- which is what lets the reader
 * below treat a non-zero exit as "the manager could not be asked" rather than
 * as an answer.
 */
const SHOWN_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'ActiveEnterTimestamp',
] as const;

function systemctl(
  scope: UnitScope,
  args: readonly string[],
): {
  readonly file: string;
  readonly args: readonly string[];
} {
  // The whole of the scope, in one place. `--user` first, because that is where
  // it reads in every example an operator has ever seen.
  return { file: SYSTEMCTL, args: scope === 'user' ? ['--user', ...args] : [...args] };
}

/**
 * A unit as the manager describes it, or as much of that as could be had.
 *
 * The state words are carried through as systemd said them rather than parsed
 * into an enumeration this file owns. That is the direction that does not
 * over-claim: `ActiveState` has six values today and systemd may name a seventh,
 * and a reader that folded an unrecognised word into `unknown` would report a
 * machine as unknowable when the manager had just told it something. Only one
 * word is compared, `failed`, and only in the one place that has to be sure.
 */
export interface UnitState {
  readonly unit: string;
  /** `LoadState`: `loaded`, or `not-found` for a unit file no reload has read. */
  readonly load: string | null;
  /** `ActiveState`: `active`, `inactive`, `failed`, `activating`, ... */
  readonly active: string | null;
  /** `SubState`, which is the sentence under `active`: `running`, `dead`, `exited`. */
  readonly sub: string | null;
  /** `UnitFileState`: `enabled`, `disabled`, `static`, `masked`. */
  readonly enabled: string | null;
  /**
   * `ActiveEnterTimestamp`, verbatim.
   *
   * Printed exactly as the manager wrote it, and not turned into "since 09:12".
   * Shortening it means a clock and a timezone this command was never given,
   * and a relative time is the one form an operator cannot paste into an issue
   * and have still mean something tomorrow.
   */
  readonly since: string | null;
  /** Why there is nothing above, or `null` when there is. */
  readonly problem: string | null;
}

/** What one act did, in the only two shapes a caller has to answer for. */
export type SystemdOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * The four things these commands do to a machine, and the one seam a test
 * replaces.
 *
 * Composed from a `ProcessRunner` and a `ProgramResolver`, so a test drives the
 * real implementation with a process table it wrote down: what is worth
 * asserting is the argv that was built and what was made of the output a real
 * `systemctl` prints, and both of those are values.
 */
export interface Systemd {
  /**
   * Whether this machine has a `systemctl` at all.
   *
   * Asked before anything is run, and separately, because the two failures want
   * different sentences: a machine with no systemd needs the foreground command
   * `install.sh` already prints, and a machine whose manager would not answer
   * needs the manager's own words. A runner that reports `unavailable` cannot
   * tell them apart -- "no such program" and "could not connect to the bus"
   * arrive the same way -- so the question is asked of the search path instead,
   * which is the same question the spawn is about to ask.
   */
  present(): Promise<boolean>;
  /** One unit, as the manager describes it. Never throws; see `UnitState`. */
  show(scope: UnitScope, unit: string): Promise<UnitState>;
  /** `daemon-reload`, so a unit file written since the last one is read. */
  reload(scope: UnitScope): Promise<SystemdOutcome>;
  /** `enable --now`: on at boot, and running now. */
  enable(scope: UnitScope, units: readonly string[]): Promise<SystemdOutcome>;
  /** `disable --now`: the exact reverse. */
  disable(scope: UnitScope, units: readonly string[]): Promise<SystemdOutcome>;
  /**
   * `stop`, and `start`, without touching whether a unit comes back at boot.
   *
   * The pair `agentplex update` uses, and the reason they are not `enable` and
   * `disable` is the whole of what an update is allowed to change. An update
   * puts different bytes on the disk; what an operator decided about boot is
   * not its business. A restart through `disable --now` and `enable --now`
   * would silently turn off a unit somebody had deliberately taken off boot,
   * and turn on one they had -- and neither is a decision this command was
   * asked to make.
   *
   * They also start exactly the units they are given, which is what lets the
   * update restart only what it found running.
   */
  stop(scope: UnitScope, units: readonly string[]): Promise<SystemdOutcome>;
  start(scope: UnitScope, units: readonly string[]): Promise<SystemdOutcome>;
}

export interface SystemdDependencies {
  /** The one-shot seam. `shell: false` and the inherited environment are its. */
  readonly runner: ProcessRunner;
  /** Where a bare `systemctl` would come from, asked the way a spawn asks it. */
  readonly programs: ProgramResolver;
}

const showOperation: Operation<UnitsRequest, UnitState> = {
  name: 'systemd.show',
  summary: 'what the manager says about one agentplex unit',
  request: unitsRequestSchema,
  timeoutMs: ASK_TIMEOUT_MS,
  argv: (request) =>
    systemctl(request.scope, [
      'show',
      ...request.units,
      ...SHOWN_PROPERTIES.map((property) => `--property=${property}`),
    ]),
  read: (completed, request) => {
    const unit = request.units[0] ?? '';
    if (completed.exitCode !== 0) {
      // Not an answer about the unit. The manager was not reachable -- no bus
      // for a user manager nothing started, a container with systemd installed
      // and not running -- and reporting `inactive` here would be this command
      // inventing a fact about a service it never asked about.
      return {
        ok: true,
        result: { ...unknownUnit(unit), problem: firstLine(completed) },
      };
    }
    // Every value through `nonEmpty`, because systemd answers a property it
    // has nothing to say about with an empty one: `ActiveEnterTimestamp=` for a
    // unit that has never run, `UnitFileState=` for one the manager could not
    // load. An empty string is not a state and not a time, and carrying one
    // into the report would print a blank column that reads as a value.
    const properties = readProperties(completed.stdout);
    const property = (name: string): string | null => nonEmpty(properties.get(name)) ?? null;
    return {
      ok: true,
      result: {
        unit,
        load: property('LoadState'),
        active: property('ActiveState'),
        sub: property('SubState'),
        enabled: property('UnitFileState'),
        since: property('ActiveEnterTimestamp'),
        problem: null,
      },
    };
  },
};

const reloadOperation: Operation<{ scope: UnitScope }, null> = {
  name: 'systemd.daemon-reload',
  summary: 'make the manager read the unit files on disk',
  request: scopeRequestSchema,
  timeoutMs: ASK_TIMEOUT_MS,
  argv: (request) => systemctl(request.scope, ['daemon-reload']),
  read: (completed) => acted(completed),
};

const enableOperation: Operation<UnitsRequest, null> = {
  name: 'systemd.enable',
  summary: 'enable agentplex units and start them now',
  request: unitsRequestSchema,
  timeoutMs: ACT_TIMEOUT_MS,
  argv: (request) => systemctl(request.scope, ['enable', '--now', ...request.units]),
  read: (completed) => acted(completed),
};

const disableOperation: Operation<UnitsRequest, null> = {
  name: 'systemd.disable',
  summary: 'stop agentplex units and take them off boot',
  request: unitsRequestSchema,
  timeoutMs: ACT_TIMEOUT_MS,
  argv: (request) => systemctl(request.scope, ['disable', '--now', ...request.units]),
  read: (completed) => acted(completed),
};

const stopOperation: Operation<UnitsRequest, null> = {
  name: 'systemd.stop',
  summary: 'stop agentplex units, leaving them enabled',
  request: unitsRequestSchema,
  timeoutMs: ACT_TIMEOUT_MS,
  argv: (request) => systemctl(request.scope, ['stop', ...request.units]),
  read: (completed) => acted(completed),
};

const startOperation: Operation<UnitsRequest, null> = {
  name: 'systemd.start',
  summary: 'start agentplex units, without changing what happens at boot',
  request: unitsRequestSchema,
  timeoutMs: ACT_TIMEOUT_MS,
  argv: (request) => systemctl(request.scope, ['start', ...request.units]),
  read: (completed) => acted(completed),
};

export function createSystemd({ runner, programs }: SystemdDependencies): Systemd {
  /**
   * One act, reduced to what a caller can do about it.
   *
   * Generic over the request rather than taking a widened operation, because
   * the alternative is a cast: `runOperation` infers the request type from the
   * operation it is handed, and that inference is what makes it impossible to
   * run `enable` against a request the disable schema parsed.
   */
  const act = async <Request>(
    operation: Operation<Request, null>,
    request: unknown,
  ): Promise<SystemdOutcome> => {
    const outcome = await runOperation(operation, request, runner);
    return outcome.ok ? { ok: true } : { ok: false, problem: outcome.problem };
  };

  return {
    async present(): Promise<boolean> {
      return (await programs.resolve(SYSTEMCTL)) !== null;
    },

    async show(scope: UnitScope, unit: string): Promise<UnitState> {
      const outcome: OperationOutcome<UnitState> = await runOperation(
        showOperation,
        { scope, units: [unit] },
        runner,
      );
      // A refusal reaching here is the program missing, the manager taking too
      // long, or a unit name this module would not build -- all of them reasons
      // there is no state, none of them a state.
      return outcome.ok ? outcome.result : { ...unknownUnit(unit), problem: outcome.problem };
    },

    reload: (scope) => act(reloadOperation, { scope }),
    enable: (scope, units) => act(enableOperation, { scope, units }),
    disable: (scope, units) => act(disableOperation, { scope, units }),
    stop: (scope, units) => act(stopOperation, { scope, units }),
    start: (scope, units) => act(startOperation, { scope, units }),
  };
}

/**
 * Exit 0 is systemd having done it. Anything else is systemd's own sentence
 * about why not -- polkit refusing an unprivileged enable of a system unit,
 * a unit file the manager will not load -- and that sentence is worth more than
 * any rewording of it here, so it is carried through.
 */
function acted(completed: CompletedProcess): OperationOutcome<null> {
  return completed.exitCode === 0
    ? { ok: true, result: null }
    : { ok: false, refusal: 'failed', problem: firstLine(completed) };
}

function unknownUnit(unit: string): UnitState {
  return { unit, load: null, active: null, sub: null, enabled: null, since: null, problem: null };
}

/**
 * `KEY=value` lines, which is what `systemctl show` writes when it is asked for
 * properties.
 *
 * A line with no `=` is skipped rather than failing the read: what is wanted is
 * five named values, and a manager that printed a sixth thing has not stopped
 * answering the question.
 */
function readProperties(stdout: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return properties;
}

/**
 * What systemd said, as one line.
 *
 * stderr first because that is where it complains, and stdout only when it said
 * nothing there. An exit code with no words beside it is a real outcome -- it
 * is what a killed process leaves -- and it gets a sentence rather than an
 * empty string, because a problem nobody can read is a problem nobody can act
 * on.
 */
function firstLine(completed: CompletedProcess): string {
  const said = nonEmpty(completed.stderr) ?? nonEmpty(completed.stdout);
  return said === undefined
    ? `systemctl exited ${completed.exitCode} and said nothing`
    : (said.split('\n')[0] ?? '').trim();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
