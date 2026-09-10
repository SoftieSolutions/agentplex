import { delimiter, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Reading settings out of argv and env, the way every daemon here does it.
 *
 * Each setting has one flag and one env var. Flags win, because a flag is
 * typed by a person at the moment they mean it and an env var is inherited.
 * An unknown flag is a failure rather than a shrug, and every problem is
 * collected rather than the first thrown: fixing one env var per restart is a
 * bad loop. These rules were the hub's and the server's while they were one
 * program, and they are here so that two programs reading one settings file
 * read it the same way.
 */

/** One setting: the flag a person types and the variable a unit file sets. */
export interface Setting {
  readonly flag: string;
  readonly env: string;
}

/**
 * The two ports, named once. The hub offers its own when nobody says
 * otherwise, and the server's default is what a hub beside it dials when
 * neither is told a port; setup offers both. Two lists of defaults that drift
 * apart are a setup run whose plan names a port nothing ever binds.
 */
export const DEFAULT_HUB_PORT = 8080;
export const DEFAULT_SERVER_PORT = 8081;

export type FlagsResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Accepts `--flag=value` and `--flag value`, and refuses anything else.
 *
 * `node:util.parseArgs` handles both forms and rejects unknown options, and it
 * was tried. Under `strict: true` it throws on the first unknown option, which
 * is the one thing this must not do: a bad invocation reports every problem at
 * once.
 *
 * Every occurrence is kept, because one flag is a list: `--store-path` twice
 * means two stores. For the settings that are single-valued the last one wins,
 * which is the shell convention and the one a wrapper script relies on when it
 * appends an override to a command line it did not write.
 */
export function readFlags(argv: readonly string[], known: Iterable<string>): FlagsResult {
  const accepted = new Set(known);
  const values = new Map<string, string[]>();
  const problems: string[] = [];
  const add = (flag: string, value: string): void => {
    const existing = values.get(flag);
    if (existing === undefined) values.set(flag, [value]);
    else existing.push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);

    if (!accepted.has(flag)) {
      problems.push(`unknown argument: ${argument}`);
      continue;
    }

    if (separator !== -1) {
      add(flag, argument.slice(separator + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      problems.push(`${flag} needs a value`);
      continue;
    }
    add(flag, next);
    index += 1;
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}

/**
 * A setting's value: the last flag given, or the env var, or nothing. An env
 * var that is empty or whitespace is absent, not an empty value, because that
 * is what an env file with a blank line after the `=` means.
 */
export function settingValue(
  values: ReadonlyMap<string, readonly string[]>,
  env: Readonly<Record<string, string | undefined>>,
  setting: Setting,
): string | undefined {
  return values.get(setting.flag)?.at(-1) ?? nonEmpty(env[setting.env]);
}

export function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** An absent setting takes its default; a present one has to parse. */
export function readSetting<S extends z.ZodType>(
  schema: S,
  raw: string | undefined,
  fallback: z.infer<S>,
  report: (raw: string) => void,
): z.infer<S> {
  if (raw === undefined) return fallback;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  report(raw);
  return fallback;
}

const portSchema = z.coerce.number().int().min(1).max(65535);

export function readPort(
  raw: string | undefined,
  flag: string,
  fallback: number,
  problems: string[],
): number {
  return readSetting(portSchema, raw, fallback, (offending) =>
    problems.push(
      `${flag} must be a port number between 1 and 65535, not ${JSON.stringify(offending)}`,
    ),
  );
}

/**
 * An absolute path, normalized to one spelling, or a problem.
 *
 * Relative is refused rather than resolved: it would name whatever directory
 * the unit file, the shell, or the container image left the process in.
 * `resolve` on an already-absolute path never consults the working directory;
 * it collapses `..` and a trailing separator so that one file has one name.
 */
export function readAbsolutePath(
  raw: string,
  flag: string,
  problems: string[],
): string | undefined {
  if (!isAbsolute(raw)) {
    problems.push(`${flag} must be an absolute path, not ${JSON.stringify(raw)}`);
    return undefined;
  }
  return resolve(raw);
}

/**
 * An ordered list of absolute directories, from repeated flags or from one
 * delimiter-separated env var.
 *
 * Flags replace the environment rather than adding to it, for the same reason
 * they win everywhere else: a person listing directories on a command line is
 * saying which ones, not which extra ones. The env var takes a `PATH`-shaped
 * list because a container is configured with environment and nothing else,
 * and mounting two volumes must not require rewriting the command.
 */
export function readAbsolutePaths(
  setting: { readonly flag: string },
  flagValues: readonly string[] | undefined,
  envValue: string | undefined,
  problems: string[],
): readonly string[] {
  const fromFlags = flagValues !== undefined;
  const raw = flagValues ?? (envValue ?? '').split(delimiter);

  const paths: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      // An empty segment in the env var is a trailing delimiter, which is a
      // typo with an obvious meaning. A flag given no value is a person asking
      // for something that does not exist, and gets told so.
      if (fromFlags) problems.push(`${setting.flag} needs a path`);
      continue;
    }

    const normalized = readAbsolutePath(trimmed, setting.flag, problems);
    if (normalized !== undefined && !paths.includes(normalized)) paths.push(normalized);
  }

  return paths;
}

/** The settings, one line each, for a usage message. */
export function usageLines(settings: Iterable<Setting>): readonly string[] {
  return [...settings].map(({ flag, env }) => `  ${flag.padEnd(16)} (${env})`);
}
