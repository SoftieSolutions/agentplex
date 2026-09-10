#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * What is left of `agentplexd`: the name the installed package still links,
 * dispatching to the one program it has left. Every other program is its own
 * app now, and AGX-99 replaces this file with the `agentplex` bin that
 * dispatches to all of them the same way.
 *
 * By path, never by import: the doctor's built entry is imported from where
 * the assembled tree puts it, the same distance `apps/hub` is from
 * `apps/web/dist`, so the rule that no app imports another holds in source.
 */
const PROGRAMS: Readonly<Record<string, string>> = {
  doctor: '../../doctor/dist/main.js',
};

const command = process.argv[2];
const program = command === undefined ? undefined : PROGRAMS[command];

if (program === undefined) {
  process.stderr.write(
    `agentplexd: ${command === undefined ? 'a command is needed' : `unknown command ${JSON.stringify(command)}`}: ` +
      `the hub is node apps/hub/dist/main.js, the server is node apps/server/dist/main.js, ` +
      `setup is node apps/setup/dist/main.js, and \`agentplexd doctor\` is the check\n`,
  );
  process.exitCode = 2;
} else {
  // The program reads `process.argv.slice(2)`, so the command word is removed
  // before it is loaded rather than passed along as a flag it would refuse.
  process.argv.splice(2, 1);
  await import(pathToFileURL(new URL(program, import.meta.url).pathname).href);
}
