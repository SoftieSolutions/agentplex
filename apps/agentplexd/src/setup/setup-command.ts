import { ROLES, type Role } from '../config/config.js';
import type { ProcessRunner, ProviderRegistry, StoreFileSystem } from '@agentplex/providers';
import type { PtySupervisor } from '../server/pty-supervisor.js';
import type { Clock, IdGenerator, TokenMinter } from '@agentplex/node-shared';
import { applySetupPlan, type SetupOutcome } from './apply-setup-plan.js';
import { describeOutcome } from './describe-outcome.js';
import type { HubDatabase } from './hub-database.js';
import type { SetupMachine } from './setup-machine.js';
import { parseSetupPlan, setupBinPath, type SetupPlan } from './setup-plan.js';
import type { SetupTerminal } from './setup-terminal.js';
import { runSetupWizard } from './setup-wizard.js';

/**
 * `agentplexd setup`: two front ends onto one provisioning.
 *
 * `--plan <file>` replays a plan with no person in it. With no plan, the wizard
 * asks what it cannot discover, builds a `SetupPlan` out of the answers, hands it
 * to the same apply path, and offers to save it. Both ends run one code path
 * against one value, which is the only way an interactive run and an unattended
 * one can be claimed to produce the same machine.
 *
 * The command is argv, a plan, and a report. Every rule about what a plan means
 * lives in `setup-plan.ts`, everything that touches the machine lives in
 * `apply-setup-plan.ts`, and every question lives in `setup-wizard.ts`, so this
 * file has one job: turn a command line into one of those runs, and turn its
 * outcome into an exit code cloud-init can act on.
 */

/** Nothing to report: the machine matches the plan. */
const EXIT_OK = 0;
/**
 * The plan ran and something in it did not work out.
 *
 * `1` rather than `2`, matching the entrypoint's two codes: this is the class of
 * failure that may pass on another run — a registry that was down, a store on a
 * mount that was not up yet — where a plan that does not parse never will.
 */
const EXIT_PROBLEMS = 1;
/** The invocation or the plan was wrong. Running it again will not help. */
const EXIT_BAD_PLAN = 2;

const PLAN_FLAG = '--plan';
const ROLE_FLAG = '--role';

export interface SetupCommandDependencies {
  /** Where the wizard asks its questions. Unused on the `--plan` path. */
  readonly terminal: SetupTerminal;
  /** What the wizard discovers from: a home directory, a PATH, and a filesystem. */
  readonly machine: SetupMachine;
  /**
   * The one-shot process seam, built from the directories the plan names.
   *
   * A factory rather than a runner, because what a child of setup inherits is a
   * fact the plan states and there is no plan until this command has read one.
   * The entrypoint composes the environment, as it does for the serving roles,
   * and stays the only place `process.env` is read.
   */
  readonly runnerFor: (binPath: readonly string[]) => ProcessRunner;
  /**
   * The pty seam, built from the same directories. Unused on the `--plan` path.
   *
   * A replay has nobody to hand a terminal to, and these logins are browser
   * OAuth flows with no unattended form — so a plan that runs at boot leaves a
   * provider it could not log in reported as exactly that, and the wizard is the
   * front end that can finish the job.
   */
  readonly supervisorFor: (binPath: readonly string[]) => PtySupervisor;
  /**
   * The providers this build can drive, given the runner they will probe with.
   *
   * A factory for the same reason, and it keeps "which providers does this build
   * drive" a visible line in the entrypoint rather than a list this file knows.
   */
  readonly providersFor: (runner: ProcessRunner) => ProviderRegistry;
  /** Where the plan is read from, and where the identity and store files are written. */
  readonly files: StoreFileSystem;
  /**
   * The hub's own database. Reached from the wizard, and from nowhere else.
   *
   * It is in this list rather than composed inside the wizard for the reason the
   * runner factories are: opening a SQLite file is a thing the process does, and
   * the entrypoint owns those. That it is *here* and still unused by
   * `replayPlan` below is the point — the capability is in reach of the
   * unattended front end, and the unattended front end does not take it, because
   * a pairing minted and then trusted with nobody present is the hub choosing
   * rather than the operator.
   */
  readonly hubDatabase: HubDatabase;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
  readonly clock: Clock;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function setupUsage(): string {
  return [
    'Usage: agentplexd setup [--role <hub|server|both>]',
    '       agentplexd setup --plan <file>',
    '',
    '  With no plan, setup asks what it cannot discover. Which providers are',
    '  installed, which directory each is in, whether they are logged in and',
    '  which stores exist are all found rather than asked, and the last screen',
    '  offers to save the plan the answers produced.',
    '',
    '  --role pre-seeds the first question rather than replacing it.',
    '',
    '  --plan replays one of those files: the providers to have, the stores to',
    '  identify, the ports, the directories a server resolves programs in, and',
    '  the pairing token if the plan brought one. Running the same plan twice',
    '  leaves the machine in the same state.',
  ].join('\n');
}

export async function runSetupCommand(
  argv: readonly string[],
  dependencies: SetupCommandDependencies,
): Promise<number> {
  const { writeError } = dependencies;
  const report = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplexd setup: ${problem}`);
    writeError(`\n${setupUsage()}`);
    return EXIT_BAD_PLAN;
  };

  const flags = readSetupFlags(argv);
  if (!flags.ok) return report(flags.problems);

  return flags.plan === null
    ? askAndProvision(flags.role, dependencies)
    : replayPlan(flags.plan, dependencies, report);
}

/**
 * The interactive front end, and the exit code its outcome deserves.
 *
 * The wizard reports through the terminal it was given, so nothing is written
 * again here: on a real machine both ends of this are the same tty, and a
 * problem printed twice reads as two problems.
 */
async function askAndProvision(
  role: Role | null,
  dependencies: SetupCommandDependencies,
): Promise<number> {
  const outcome = await runSetupWizard({ role }, dependencies);

  if (outcome.kind === 'no-input') {
    // Nothing was asked and nothing was assumed. The other front end is the one
    // that works without a person, so it is what this points at.
    dependencies.writeError(
      `agentplexd setup: there is nobody to ask. Run it in a terminal, or replay a plan with ${PLAN_FLAG} <file>.`,
    );
    return EXIT_BAD_PLAN;
  }

  // The same code a plan file that does not parse gets, because it is the same
  // fact: these answers will not provision a machine however many times they are
  // given. The wizard has already named which field.
  if (outcome.kind === 'unusable') return EXIT_BAD_PLAN;

  // A plan the operator declined is a run that did what it was asked. Nothing on
  // the machine was changed and nothing failed, and an installer that treated
  // that as an error would be wrong about it.
  if (outcome.kind === 'abandoned') return EXIT_OK;

  return outcome.problems.length === 0 ? EXIT_OK : EXIT_PROBLEMS;
}

async function replayPlan(
  file: string,
  dependencies: SetupCommandDependencies,
  report: (problems: readonly string[]) => number,
): Promise<number> {
  const { write, writeError } = dependencies;

  const contents = await dependencies.files.readFile(file);
  if (contents.kind !== 'read') {
    return report([
      contents.kind === 'missing'
        ? `there is no plan at ${file}`
        : `cannot read ${file}: ${contents.reason}`,
    ]);
  }

  const parsed = parseSetupPlan(contents.contents);
  if (!parsed.ok) {
    // Every problem in the file, not the first. A plan replayed on a machine
    // that boots to run it fails whole, and fixing one field per boot is the
    // loop this shape exists to avoid.
    return report(parsed.problems.map((problem) => `${file}: ${problem}`));
  }

  const runner = dependencies.runnerFor(setupBinPath(parsed.plan));
  const outcome = await applySetupPlan(parsed.plan, {
    runner,
    providers: dependencies.providersFor(runner),
    files: dependencies.files,
    ids: dependencies.ids,
    tokens: dependencies.tokens,
  });

  write(`agentplexd setup: replayed ${file}`);
  for (const line of describeOutcome(outcome)) write(line);
  for (const line of describeUnattendedPairing(parsed.plan, outcome)) write(line);
  for (const problem of outcome.problems) writeError(`agentplexd setup: ${problem}`);

  return outcome.problems.length === 0 ? EXIT_OK : EXIT_PROBLEMS;
}

/**
 * What a replay says about pairing, which is what is left to do and never a
 * pairing it made.
 *
 * The exception the wizard takes — mint the token, write both ends, type
 * nothing — is for one operator on one host in one interactive run. None of that
 * is true here, and the difference is not a scruple: a run that minted a token
 * at boot and then trusted it on the strength of having minted it would be the
 * hub deciding which machines it trusts, which is exactly what the rule about
 * typed tokens exists to prevent. So this path writes no row, and there is no
 * database in a `SetupPlan` for it to write one into.
 *
 * That leaves two honest reports, and the difference between them is whether an
 * operator chose the secret:
 *
 * - **The plan named a token.** This is the sanctioned unattended path, and the
 *   whole reason `pairingToken` is in the schema: somebody decided the token
 *   before the machine existed, so the instance is pairable the moment it boots
 *   and the hub's end is made by whoever holds the hub, with a secret they
 *   already have.
 * - **The plan named none.** A token was minted onto this machine, and the only
 *   thing that knows it is a file on it. Somebody has to read that file and type
 *   it into a hub, which is the ordinary rule, unchanged.
 */
function describeUnattendedPairing(plan: SetupPlan, outcome: SetupOutcome): readonly string[] {
  if (outcome.role !== 'both' || outcome.server === null || !('server' in plan)) return [];

  const identityPath = outcome.server.identity.path;
  return [
    plan.server.pairingToken === null
      ? `pairing: a token was minted into ${identityPath}. Type it into the hub to pair this ` +
        'machine; an unattended run does not pair a hub with a token it minted itself.'
      : `pairing: this machine is pairable with the token the plan named, which is in ` +
        `${identityPath}. Nothing here writes the hub's end of it.`,
  ];
}

type SetupFlags =
  | {
      readonly ok: true;
      /** The plan to replay, or `null` to ask. */
      readonly plan: string | null;
      /** The role the wizard starts on, or `null` to offer the usual one. */
      readonly role: Role | null;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The two flags this command takes.
 *
 * An unknown argument is a refusal rather than a shrug, for the reason
 * `readFlags` gives: silently ignoring `--pln` would replay nothing and report
 * success. `--plan <file>` and `--plan=<file>` are both accepted, and the last
 * one wins, because that is the convention every other flag in this binary
 * follows and a second convention is a thing to remember.
 *
 * The two together are refused. `--role` pre-seeds a question, and a plan
 * already states its role — so an invocation carrying both is somebody expecting
 * one of them to win, and the one they expected is not knowable from here.
 *
 * A plan path is used exactly as it was typed. A relative one resolves against
 * the directory the operator was standing in when they typed it, which is what
 * they meant; the paths *inside* a plan are a different question, and the plan
 * parser refuses those unless they are absolute.
 */
function readSetupFlags(argv: readonly string[]): SetupFlags {
  const problems: string[] = [];
  let plan: string | null = null;
  let role: Role | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (flag !== PLAN_FLAG && flag !== ROLE_FLAG) {
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    let value: string;
    if (separator !== -1) {
      value = argument.slice(separator + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        problems.push(`${flag} needs a value`);
        continue;
      }
      value = next;
      index += 1;
    }

    if (value.length === 0) {
      problems.push(`${flag} needs a value`);
      continue;
    }

    if (flag === PLAN_FLAG) {
      plan = value;
      continue;
    }

    const named = ROLES.find((one) => one === value);
    if (named === undefined) {
      problems.push(`${ROLE_FLAG} takes one of: ${ROLES.join(', ')}`);
      continue;
    }
    role = named;
  }

  if (plan !== null && role !== null) {
    problems.push(`${ROLE_FLAG} pre-seeds the wizard, and a plan states its own role: pass one`);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, plan, role };
}
