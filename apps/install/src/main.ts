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
 * `--help` is answered on stdout, and `--version` with it. Both are questions
 * this command was asked and answered, so they are its output, and an operator
 * who pipes either into `grep` or `$(...)` gets what they asked for. Being told
 * that a command does not exist is the other kind of line -- a diagnostic about
 * a run that failed -- so it keeps stderr and exit 2, and the usage printed
 * beside it goes there too: it is there to help with the failure rather than
 * because anybody asked for it.
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
 * This app's manifest: the file `bin` is declared in, and the one whose version
 * the published package carries.
 *
 * `..` and not `../..`. The programs are resolved from a sibling app's `dist`,
 * two levels up and back down, while the manifest sits one level up from the
 * `dist` this file is emitted into -- a different depth, from the same anchor.
 * `import.meta.url` is that anchor for both, because every home of this file
 * keeps the workspace layout, so one expression is correct in a checkout, in
 * the image and in the published tarball alike.
 */
const MANIFEST = new URL('../package.json', import.meta.url);

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
} else {
  const program = command === undefined ? undefined : PROGRAMS[command];
  if (program === undefined) {
    if (command !== undefined) {
      process.stderr.write(`agentplex: unknown command ${JSON.stringify(command)}\n\n`);
    }
    process.stderr.write(`${usage()}\n`);
    process.exitCode = EXIT_BAD_COMMAND;
  } else {
    process.argv.splice(2, 1);
    await import(new URL(program.entry, import.meta.url).href);
  }
}
