import { readPin, type Pin } from '@agentplex/release';
import { COMPONENTS, type Component } from '../../installation/components.js';
import { lookupUsageLines, readLookupFlags } from '../../installation/lookup-flags.js';

/**
 * What `agentplex update` was asked to do.
 *
 * The same words `install.sh` takes, deliberately: a component is named by the
 * word its release tag carries, and a pin is `@<version>` after it. Somebody
 * who installed with `--role=hub@1.3.0` and updates with `agentplex update
 * hub@1.3.0` should not have to learn a second grammar for the same idea.
 *
 * Two things about the grammar are decisions rather than conveniences.
 *
 * **Naming a component that is not installed is an error.** `setup` installs
 * what is missing and `update` updates what is there, and the two verbs stay
 * apart. `agentplex update server` on a hub machine is somebody who thinks this
 * box runs a server; a silent no-op would leave them believing it, and an
 * install would turn a typo into a new daemon.
 *
 * **A pin is exact or a series, as it is for `install.sh`.** `hub@1.3.0` names
 * a release tag; `hub@1.3` and `hub@1` name a series, which resolves to the
 * newest release the manifest lists under it and never to a prerelease. The
 * grammar and the resolver are `packages/release`'s `pin.ts`, held against the
 * installer's bash by the table both suites run. This reads the word; the
 * series is resolved once the manifest has been read -- see `resolve-pins.ts`.
 */

export const CHECK_FLAG = '--check';
export const DRY_RUN_FLAG = '--dry-run';
export const NODE_FLAG = '--node';
export const NO_NODE_FLAG = '--no-node';

/** One component named on the command line, with the pin it was given. */
export interface AskedComponent {
  readonly component: Component;
  /** An exact release or a series, or `null` for whatever the manifest calls current. */
  readonly pin: Pin | null;
}

/**
 * Whether the runtime may be replaced, before anybody has been asked.
 *
 * Three values and not a boolean, because "nobody has said" is a different
 * state from "no" and leads somewhere else: it is the one that looks for a
 * terminal, and the one that skips the runtime with a line saying so when there
 * is none. An unattended run that took silence for consent would replace the
 * interpreter on a fleet of machines nobody was watching.
 */
export type RuntimeConsent = 'yes' | 'no' | 'ask';

export type UpdateFlags =
  | {
      readonly ok: true;
      /** Empty means everything installed, which is what a bare `update` means. */
      readonly asked: readonly AskedComponent[];
      readonly check: boolean;
      readonly dryRun: boolean;
      readonly runtime: RuntimeConsent;
      readonly prefix: string | null;
      readonly system: boolean;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

export function readUpdateFlags(argv: readonly string[]): UpdateFlags {
  const problems: string[] = [];
  const asked: AskedComponent[] = [];
  const forLookup: string[] = [];
  let check = false;
  let dryRun = false;
  let runtime: RuntimeConsent = 'ask';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (argument === CHECK_FLAG) {
      check = true;
      continue;
    }
    if (argument === DRY_RUN_FLAG) {
      dryRun = true;
      continue;
    }
    if (argument === NODE_FLAG || argument === NO_NODE_FLAG) {
      runtime = argument === NODE_FLAG ? 'yes' : 'no';
      continue;
    }
    if (argument.startsWith('-')) {
      // Everything else that looks like a flag is `--prefix` and `--system`,
      // read by the one reader all four installation commands share. It takes
      // a value that may be the next word, so the word after `--prefix` goes
      // with it rather than being read here as a component.
      forLookup.push(argument);
      if (argument === '--prefix') {
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith('-')) {
          forLookup.push(value);
          index += 1;
        }
      }
      continue;
    }

    const named = readComponent(argument);
    if (!named.ok) {
      problems.push(named.problem);
      continue;
    }
    // Named twice is a contradiction rather than last-one-wins, which is the
    // rule `install.sh` applies to a component pinned twice. Two versions of
    // one component is not something to pick between.
    if (asked.some((one) => one.component === named.value.component)) {
      problems.push(`${named.value.component} is named twice`);
      continue;
    }
    asked.push(named.value);
  }

  const lookup = readLookupFlags(forLookup);
  if (!lookup.ok) problems.push(...lookup.problems);

  if (check && dryRun) {
    // Both stop before anything is installed, so this is two words for one run
    // rather than a dangerous combination -- and that is exactly why it is
    // refused. They answer different questions, and a run that was asked both
    // would have to pick one to print.
    problems.push(
      `${CHECK_FLAG} and ${DRY_RUN_FLAG} are two questions: ${CHECK_FLAG} says what is ` +
        `available and ${DRY_RUN_FLAG} says what would happen. Ask one of them`,
    );
  }

  if (problems.length > 0 || !lookup.ok) return { ok: false, problems };
  return { ok: true, asked, check, dryRun, runtime, prefix: lookup.prefix, system: lookup.system };
}

function readComponent(
  argument: string,
): { ok: true; value: AskedComponent } | { ok: false; problem: string } {
  const separator = argument.indexOf('@');
  const name = separator === -1 ? argument : argument.slice(0, separator);
  const word = separator === -1 ? null : argument.slice(separator + 1);

  if (!isComponent(name)) {
    return {
      ok: false,
      problem: `${JSON.stringify(argument)} names no component: this machine has ${COMPONENTS.join(
        ', ',
      )}`,
    };
  }

  if (word === null) return { ok: true, value: { component: name, pin: null } };
  const pin = readPin(word);
  if (pin === null) {
    return {
      ok: false,
      problem:
        `${name} is pinned to ${JSON.stringify(word)}, which is not a version this can ` +
        'install: a pin is an exact <major>.<minor>.<patch>, naming the release tag ' +
        `${name}-v<version>, or a series -- <major>.<minor> or <major> -- which resolves to ` +
        'the newest release published under it',
    };
  }
  return { ok: true, value: { component: name, pin } };
}

function isComponent(name: string): name is Component {
  return (COMPONENTS as readonly string[]).includes(name);
}

/** The usage, which is also where the grammar is written down for a person. */
export function updateUsage(): string {
  return [
    'Usage: agentplex update [<component>[@<version>] ...] [options]',
    '',
    '  Brings this machine up to the versions versions.json calls current. It updates',
    '  what is installed here and installs nothing new: agentplex setup is what adds a',
    `  component. The components are ${COMPONENTS.join(', ')}.`,
    '',
    `  ${CHECK_FLAG}               what is available, from the release manifest. Installs`,
    '                        nothing, and refreshes the cache agentplex status reads.',
    `  ${DRY_RUN_FLAG}             the plan, in the order it would happen.`,
    `  ${NODE_FLAG} / ${NO_NODE_FLAG}     replace the runtime in this prefix, or leave it. Without`,
    '                        either, you are asked, and an unattended run leaves it.',
    '',
    ...lookupUsageLines(),
    '',
    '  A pin is exact or a series. hub@1.3.0 names a release tag;',
    '  hub@1.3 takes the newest 1.3.x the manifest lists, and hub@1 the newest 1.x.',
    '  A series never resolves to a prerelease, which is pinned by its full version.',
  ].join('\n');
}
