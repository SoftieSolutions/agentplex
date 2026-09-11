#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PROGRAMS } from './programs.js';

/**
 * The `agentplex` bin: one command an operator installs, dispatching to the
 * program named by its first argument. Where each program lives, and why it is
 * reached by path rather than by import, is argued in `programs.ts`.
 *
 * The program reads `process.argv.slice(2)`, so the command word is removed
 * before it is loaded rather than passed along as a flag it would refuse.
 *
 * `--help` is answered on stdout, and `--version` and the `help` command with
 * it. All three are questions this command was asked and answered, so they are
 * its output, and an operator who pipes one into `grep` or `$(...)` gets what
 * they asked for. Being told that a command does not exist is the other kind of
 * line -- a diagnostic about a run that failed -- so it keeps stderr and exit
 * 2, and the usage printed beside it goes there too: it is there to help with
 * the failure rather than because anybody asked for it.
 *
 * The shebang above is the whole of what makes this file a command: `bin` in
 * a package.json is a path, not an interpreter, and a file without one is
 * handed to the shell. `tsc` copies it into the emitted file.
 */

/** The operator asked for a program that is not one. */
const EXIT_BAD_COMMAND = 2;

/** The manifest was missing or unreadable, so there is no version to report. */
const EXIT_NO_VERSION = 1;

/**
 * The manifest `--version` is read out of: the package root's, three levels up
 * from the `dist` this file is emitted into.
 *
 * Not `../package.json`, which is this app's own manifest -- the file `bin` is
 * declared in, and the obvious answer. It is also a file that exists only where
 * this repository does: packaging copies `apps/cli/dist` and never the manifest
 * beside it, and the published `files` list does not name it, so on an
 * installed machine that path is an ENOENT and `--version` was a diagnostic and
 * an exit 1 rather than a version. It shipped that way because the one suite
 * that runs this bin runs it in a checkout, where the file is there.
 *
 * `../../..` is the one expression correct in every home, and correct for the
 * reason the programs are reached by path at all: each home keeps the workspace
 * layout. In the published tarball it is the manifest `assemble-package.ts`
 * wrote, carrying the version the release tag named. In a checkout and in the
 * image it is the workspace's own, which says `0.0.0` -- deliberately, because
 * nothing in this repository carries a version and the tag is the single
 * statement of what was released.
 */
const MANIFEST = new URL('../../../package.json', import.meta.url);

function usage(): string {
  const width = Math.max(...Object.keys(PROGRAMS).map((name) => name.length));
  return [
    'Usage: agentplex <command> [options]',
    '',
    ...Object.entries(PROGRAMS).map(
      ([name, program]) => `  ${name.padEnd(width)}   ${program.summary}`,
    ),
    '',
    '  Each command takes its own options; agentplex <command> --help lists them.',
    '  agentplex --version prints the version of this package.',
  ].join('\n');
}

/**
 * The version out of a manifest read off disk, which is external input like
 * anything else. A file that is not JSON, or that carries no `version` string,
 * is a claim this cannot make: it is refused rather than cast, so that nothing
 * here can print `undefined` and call it a version.
 */
function parseVersion(source: string, text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${String(error)}`);
  }
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['version']
      : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${source} declares no version`);
  }
  return version;
}

/**
 * Somebody named a command that is not one, whether they named it after `help`
 * or on its own. A diagnostic about a run that failed, so stderr and exit 2,
 * with the usage beside it because it is there to help with the failure.
 */
function refuse(name: string): void {
  process.stderr.write(`agentplex: unknown command ${JSON.stringify(name)}\n\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = EXIT_BAD_COMMAND;
}

/**
 * `agentplex help [command]`: the same questions `--help` answers, in the word
 * order somebody who has met git types them in.
 *
 * `help <command>` rewrites argv to `<command> --help` and dispatches, rather
 * than printing anything itself. Every program answers `--help` before it reads
 * its configuration and writes its own usage to stdout, so there is exactly one
 * source of usage text per command and this file holds no copy of any of it to
 * drift. Two argv entries become one: the program reads `process.argv.slice(2)`
 * and has no way to tell how it was asked.
 *
 * `help` alone, and `help help`, answer with the top-level usage on stdout and
 * exit 0 -- it is the only text either of them names, and a help request is a
 * question answered rather than a run that failed.
 *
 * Anything else after `help` is refused exactly as a command word is, flags
 * included: this takes the name of a command, and `--help` is not one. A
 * request nobody can act on is a diagnostic, whichever word order it arrived
 * in.
 */
async function help(subject: string | undefined): Promise<void> {
  const asked = subject === undefined ? undefined : PROGRAMS[subject];
  if (subject !== undefined && asked === undefined) {
    refuse(subject);
  } else if (asked?.kind === 'dispatched') {
    process.argv.splice(2, 2, '--help');
    await import(new URL(asked.entry, import.meta.url).href);
  } else {
    process.stdout.write(`${usage()}\n`);
  }
}

const command = process.argv[2];

if (command === '--help' || command === '-h') {
  process.stdout.write(`${usage()}\n`);
} else if (command === '--version') {
  const path = fileURLToPath(MANIFEST);
  try {
    process.stdout.write(`${parseVersion(path, await readFile(MANIFEST, 'utf8'))}\n`);
  } catch (error) {
    // No `unknown`, no `0.0.0`, and a non-zero exit: a script reading this
    // wants the version or an error, and a plausible-looking guess is the one
    // answer that would be believed and wrong.
    process.stderr.write(`agentplex: cannot read its own version: ${String(error)}\n`);
    process.exitCode = EXIT_NO_VERSION;
  }
} else if (command === undefined) {
  // Nothing was named, so there is nothing to name back. The usage is still a
  // diagnostic here -- a run that did nothing -- which is why it is not the
  // stdout answer `--help` gets.
  process.stderr.write(`${usage()}\n`);
  process.exitCode = EXIT_BAD_COMMAND;
} else {
  const program = PROGRAMS[command];
  if (program === undefined) {
    refuse(command);
  } else if (program.kind === 'builtin') {
    // `help` is the only one, and it is in the table so that the usage lists
    // it. What it does with the rest of argv is above.
    await help(process.argv[3]);
  } else {
    process.argv.splice(2, 1);
    await import(new URL(program.entry, import.meta.url).href);
  }
}
