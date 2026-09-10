#!/usr/bin/env node
import process from 'node:process';

/**
 * The `agentplex` bin: one command an operator installs, dispatching to the
 * program named by its first argument.
 *
 * By path, never by import. Each program's built entry is loaded from where
 * the assembled tree puts it, the same distance `apps/hub` is from
 * `apps/web/dist`, so the rule that no app imports another holds in source and
 * composition happens where it belongs: in the package, where five `dist/`
 * directories sit next to one another. The paths are the workspace's, so this
 * file is correct from a checkout, in the image and in the published tarball
 * alike.
 *
 * The program reads `process.argv.slice(2)`, so the command word is removed
 * before it is loaded rather than passed along as a flag it would refuse.
 *
 * The shebang above is the whole of what makes this file a command: `bin` in
 * a package.json is a path, not an interpreter, and a file without one is
 * handed to the shell. `tsc` copies it into the emitted file.
 */

const PROGRAMS: Readonly<Record<string, { readonly entry: string; readonly summary: string }>> = {
  hub: { entry: '../../hub/dist/main.js', summary: 'the hub daemon' },
  server: { entry: '../../server/dist/main.js', summary: 'the server daemon' },
  setup: { entry: '../../setup/dist/main.js', summary: 'the wizard, or --plan <file> to replay' },
  doctor: { entry: '../../doctor/dist/main.js', summary: 'read-only check of this machine' },
};

/** The operator asked for a program that is not one. */
const EXIT_BAD_COMMAND = 2;

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
  ].join('\n');
}

const command = process.argv[2];
const program = command === undefined ? undefined : PROGRAMS[command];

if (program === undefined) {
  if (command !== undefined && command !== '--help' && command !== '-h') {
    process.stderr.write(`agentplex: unknown command ${JSON.stringify(command)}\n\n`);
  }
  process.stderr.write(`${usage()}\n`);
  process.exitCode = command === '--help' || command === '-h' ? 0 : EXIT_BAD_COMMAND;
} else {
  process.argv.splice(2, 1);
  await import(new URL(program.entry, import.meta.url).href);
}
