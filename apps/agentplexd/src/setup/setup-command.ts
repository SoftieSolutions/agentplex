import type { ProcessRunner } from '../server/operations/process-runner.js';
import type { ProviderRegistry } from '../server/providers/provider-registry.js';
import type { StoreFileSystem } from '../server/store-identity.js';
import type { IdGenerator } from '../shared/ids.js';
import type { TokenMinter } from '../shared/tokens.js';
import {
  applySetupPlan,
  type ProviderReport,
  type SetupOutcome,
  type ServerSetupOutcome,
} from './apply-setup-plan.js';
import { parseSetupPlan, setupBinPath } from './setup-plan.js';

/**
 * `agentplexd setup --plan <file>`: a plan replayed unattended.
 *
 * This is the front end that has no person in it. The interactive wizard is the
 * other one, and it produces a `SetupPlan` rather than doing anything itself, so
 * both ends run the same provisioning against the same value. Building this half
 * first is what gives the wizard something to produce into.
 *
 * The command is argv, a file, and a report. Every rule about what a plan means
 * lives in `setup-plan.ts`, and everything that touches the machine lives in
 * `apply-setup-plan.ts`, so this file has one job: turn a command line into one
 * of those runs, and turn its outcome into lines somebody can read and an exit
 * code cloud-init can act on.
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

export interface SetupCommandDependencies {
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
   * The providers this build can drive, given the runner they will probe with.
   *
   * A factory for the same reason, and it keeps "which providers does this build
   * drive" a visible line in the entrypoint rather than a list this file knows.
   */
  readonly providersFor: (runner: ProcessRunner) => ProviderRegistry;
  /** Where the plan is read from, and where the identity and store files are written. */
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function setupUsage(): string {
  return [
    'Usage: agentplexd setup --plan <file>',
    '',
    '  Replays a setup plan: the providers to have, the stores to identify, the',
    '  ports, the directories a server resolves programs in, and the pairing',
    '  token if the plan brought one. Running the same plan twice leaves the',
    '  machine in the same state.',
  ].join('\n');
}

export async function runSetupCommand(
  argv: readonly string[],
  dependencies: SetupCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const report = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplexd setup: ${problem}`);
    writeError(`\n${setupUsage()}`);
    return EXIT_BAD_PLAN;
  };

  const planFile = readPlanFlag(argv);
  if (!planFile.ok) return report(planFile.problems);

  const file = await dependencies.files.readFile(planFile.file);
  if (file.kind !== 'read') {
    return report([
      file.kind === 'missing'
        ? `there is no plan at ${planFile.file}`
        : `cannot read ${planFile.file}: ${file.reason}`,
    ]);
  }

  const parsed = parseSetupPlan(file.contents);
  if (!parsed.ok) {
    // Every problem in the file, not the first. A plan replayed on a machine
    // that boots to run it fails whole, and fixing one field per boot is the
    // loop this shape exists to avoid.
    return report(parsed.problems.map((problem) => `${planFile.file}: ${problem}`));
  }

  const runner = dependencies.runnerFor(setupBinPath(parsed.plan));
  const outcome = await applySetupPlan(parsed.plan, {
    runner,
    providers: dependencies.providersFor(runner),
    files: dependencies.files,
    ids: dependencies.ids,
    tokens: dependencies.tokens,
  });

  write(`agentplexd setup: replayed ${planFile.file}`);
  for (const line of describeOutcome(outcome)) write(line);
  for (const problem of outcome.problems) writeError(`agentplexd setup: ${problem}`);

  return outcome.problems.length === 0 ? EXIT_OK : EXIT_PROBLEMS;
}

type PlanFlag =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The one flag this command takes.
 *
 * An unknown argument is a refusal rather than a shrug, for the reason
 * `readFlags` gives: silently ignoring `--pln` would replay nothing and report
 * success. `--plan <file>` and `--plan=<file>` are both accepted, and the last
 * one wins, because that is the convention every other flag in this binary
 * follows and a second convention is a thing to remember.
 *
 * The path is used exactly as it was typed. A relative one resolves against the
 * directory the operator was standing in when they typed it, which is what they
 * meant; the paths *inside* a plan are a different question, and the plan parser
 * refuses those unless they are absolute.
 */
function readPlanFlag(argv: readonly string[]): PlanFlag {
  const problems: string[] = [];
  let file: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (flag !== PLAN_FLAG) {
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    if (separator !== -1) {
      file = argument.slice(separator + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      problems.push(`${PLAN_FLAG} needs a value`);
      continue;
    }
    file = next;
    index += 1;
  }

  if (file === undefined || file.length === 0) {
    // There is no interactive fallback in this build, and saying so is better
    // than starting one that does not exist. The wizard is the other front end
    // and it will be the way in with no `--plan` at all.
    problems.push(`no plan: pass ${PLAN_FLAG} <file>`);
  }

  return problems.length > 0 || file === undefined ? { ok: false, problems } : { ok: true, file };
}

/**
 * The run as lines a person reads.
 *
 * Facts and no advice: what role this machine is, what it will resolve programs
 * in, which providers are there and whether they are logged in. The pairing
 * token is named by its location and never printed — a terminal is a scrollback
 * and, on a cloud instance, the boot log.
 */
function describeOutcome(outcome: SetupOutcome): readonly string[] {
  const lines = [`role: ${outcome.role}`];
  if (outcome.hub !== null) lines.push(`hub: port ${outcome.hub.port}`);
  if (outcome.server !== null) lines.push(...describeServer(outcome.server));
  return lines;
}

function describeServer(server: ServerSetupOutcome): readonly string[] {
  const lines = [
    `server: port ${server.port}`,
    `bin path: ${server.binPath.join(', ')}`,
    `identity: ${server.identity.path}${
      server.identity.serverId === null ? '' : ` (server ${server.identity.serverId})`
    }${server.identity.minted ? ' - minted; the pairing token is in that file' : ''}`,
  ];

  for (const store of server.stores) {
    lines.push(
      store.ok
        ? `store: ${store.store.path} (store ${store.store.storeId})${store.minted ? ' - minted' : ''}`
        : `store: ${store.path} - unusable`,
    );
  }

  for (const provider of server.providers) lines.push(describeProvider(provider));

  return lines;
}

function describeProvider(provider: ProviderReport): string {
  const state =
    provider.authState === null
      ? 'login state unknown'
      : provider.authState === 'authenticated'
        ? 'logged in'
        : 'not logged in';

  if (provider.action === 'none') {
    // What is on the machine, when there is something, so that "the pinned
    // version could not be installed" does not read as "there is no provider".
    // Why it could not be is one of the problem lines on stderr.
    const present = provider.version === null ? '' : ` (${provider.version} is what is there)`;
    return `provider: ${provider.provider} - not provisioned${present}`;
  }

  return `provider: ${provider.provider} ${provider.version ?? 'version unknown'} - ${provider.action}, ${state}`;
}
