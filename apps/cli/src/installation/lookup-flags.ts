import { isAbsolute, resolve } from 'node:path';
import type { InstallationLookup } from './installation.js';

/**
 * The two arguments `start`, `stop` and `status` take, read the same way by all
 * three.
 *
 * Deliberately not `readFlags`. That reader requires a value for every flag it
 * knows, which is right for a table of settings and wrong for `--system`: the
 * installer's flag takes none, and a command that made an operator type
 * `--system=true` to name the thing they installed with `--system` would be a
 * second spelling of one decision. `setup` rolls its own reader for the same
 * kind of reason, and this is a smaller version of it.
 *
 * `--prefix` is refused unless it is absolute, for the reason every other path
 * in this app is: a prefix that moves with the working directory is a command
 * that reports on, or starts, whatever happens to be under wherever the
 * operator was standing.
 *
 * There is no environment fallback, and `AGENTPLEX_PREFIX` in particular is not
 * read from the ambient environment. `setup` argues it: that line is a record
 * `install.sh` wrote into a file for a person to read and pass back, and taking
 * it out of the environment would be a second opinion about where this
 * machine's files live. It *is* read out of the settings file, which is the
 * file it was written into.
 */

export const PREFIX_FLAG = '--prefix';
export const SYSTEM_FLAG = '--system';

export type LookupFlags =
  | { readonly ok: true; readonly prefix: string | null; readonly system: boolean }
  | { readonly ok: false; readonly problems: readonly string[] };

export function readLookupFlags(argv: readonly string[]): LookupFlags {
  const problems: string[] = [];
  let prefix: string | null = null;
  let system = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (flag === SYSTEM_FLAG) {
      if (separator !== -1) {
        problems.push(`${SYSTEM_FLAG} takes no value: ${argument}`);
        continue;
      }
      system = true;
      continue;
    }

    if (flag !== PREFIX_FLAG) {
      // Refused rather than ignored, for the reason `readFlags` gives: a
      // silently dropped `--prefx` would report on a different machine than the
      // operator asked about, and say nothing.
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    let value: string;
    if (separator !== -1) {
      value = argument.slice(separator + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        problems.push(`${PREFIX_FLAG} needs a value`);
        continue;
      }
      value = next;
      index += 1;
    }

    if (value.length === 0) {
      problems.push(`${PREFIX_FLAG} needs a value`);
      continue;
    }
    if (!isAbsolute(value)) {
      problems.push(`${PREFIX_FLAG} has to be an absolute path: ${value}`);
      continue;
    }
    prefix = resolve(value);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, prefix, system };
}

/** The flags, as the lookup the installation reader takes. */
export function lookupFor(
  home: string,
  flags: { prefix: string | null; system: boolean },
): InstallationLookup {
  return { home, prefix: flags.prefix, system: flags.system };
}

/** The two lines of usage all three commands share. */
export function lookupUsageLines(): readonly string[] {
  return [
    `  ${PREFIX_FLAG} <directory>   the prefix an install created, when it was not the default.`,
    '                        install.sh records it as AGENTPLEX_PREFIX in the settings',
    '                        file it wrote, so a machine can be asked where it went.',
    `  ${SYSTEM_FLAG}              the install under a service account, on a machine that also`,
    '                        has one of your own. Without it, yours is the one meant.',
  ];
}
