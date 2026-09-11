#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DAEMONS, PROGRAMS, type InAppCommand } from './programs.js';
import { NO_UPDATE_CHECK_FLAG, noticeWanted } from './versions/notice-flags.js';

/**
 * The `agentplex` bin: the one command an operator installs, dispatching to the
 * command named by its first argument. All of them are this app's own modules
 * now -- what that costs, what it buys, and why the two daemons are in no table
 * this dispatches from, is argued in `programs.ts`.
 *
 * Every command reads `process.argv.slice(2)`, so the command word is removed
 * before the module is loaded rather than passed along as a flag it would
 * refuse. A command must not be able to tell that it was reached through this
 * bin rather than started on its own.
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
 *
 * ## The one thing this file does that no command asked for
 *
 * The passive update notice: one line on stderr, after the command has
 * finished, when a newer agentplex exists than the one that just ran. It is
 * here rather than in a command because it belongs to no command -- it is a
 * property of the bin -- and three things about how it is wired are decisions.
 *
 * **It is loaded before the command runs and called after.** `agentplex update`
 * replaces the package this file is running out of, so a module imported after
 * it has finished is a module in a tree that moved. Resolving the notice first
 * and only calling it afterwards is the same rule the update command follows
 * internally, applied to the one caller above it.
 *
 * **It is loaded at all only when it could be printed.** `noticeWanted` is a
 * pure function in a module with no imports, so the usual run -- a pipe, a CI
 * job, `$(agentplex --version)` -- answers no and never evaluates the release
 * schema, the provider seam or zod. The laziness argued in `programs.ts` is
 * worth nothing if this file drags them in on every run.
 *
 * **`--version` never carries one.** It is answered above the dispatch and
 * returns before the notice is reached, which is stronger than a condition
 * somebody could later move.
 */

/**
 * Whether a notice could be printed, decided before anything is dispatched.
 *
 * Read here because it is a fact about this process -- a terminal, an
 * environment, an argv -- and this file is where those are read.
 */
const NOTICE = noticeWanted({
  stderrIsTty: process.stderr.isTTY === true,
  environment: process.env,
  argv: process.argv.slice(2),
});

/**
 * The notice's flag, removed from `process.argv` itself.
 *
 * Every command reads `process.argv.slice(2)` and refuses an argument it does
 * not know, so a flag this file handles has to be gone before a command is
 * loaded -- exactly as the command word is. Removed in place rather than
 * filtered into a copy, because the dispatch below splices the same array.
 */
for (let index = process.argv.length - 1; index >= 2; index -= 1) {
  if (process.argv[index] === NO_UPDATE_CHECK_FLAG) process.argv.splice(index, 1);
}

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
 * `../../..` is the one expression correct in every home, for the reason every
 * path in this package is: each home keeps the workspace layout. This bin no
 * longer resolves a sibling app's `dist/` -- the daemons are dispatched to from
 * nowhere now -- but the invariant did not leave with them, because the systemd
 * unit names `<prefix>/lib/node_modules/<package>/apps/hub/dist/main.js` and the
 * image runs `apps/hub/dist/main.js`. Both are the same assumption, read from
 * outside. In the published tarball it is the manifest `assemble-package.ts`
 * wrote, carrying the version the release tag named. In a checkout and in the
 * image it is the workspace's own, which says `0.0.0` -- deliberately, because
 * nothing in this repository carries a version and the tag is the single
 * statement of what was released.
 */
const MANIFEST = new URL('../../../package.json', import.meta.url);

/**
 * The usage, and the one decision in it: the daemons get a sentence at the
 * bottom and no line in the table.
 *
 * The table is the set of words that do something, so a `hub` row in it would
 * be a command again -- listed beside `doctor`, indistinguishable from it, and
 * typed by the next person to read this. Leaving the two out entirely is the
 * other wrong answer: `agentplex hub` is what every unit file, every document
 * and every habit says, and the operator asking `--help` where it went would
 * find the one place they looked silent about it.
 *
 * So they are named, below the table and as what they are. Both halves come out
 * of `DAEMONS` rather than being written here, because a sentence naming a unit
 * this bin does not otherwise know about is a sentence that goes stale without
 * anything failing.
 */
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
    '',
    `  ${Object.keys(DAEMONS).join(' and ')} are daemons rather than commands. Nobody types them:`,
    `  systemd runs them, from ${Object.values(DAEMONS).join(' and ')}.`,
    '  agentplex start, stop and status are how you reach them.',
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
 *
 * `hub` and `server` are answered before that and differently. They are the same
 * failure -- a word that runs nothing, so the same stream and the same exit code
 * -- and a completely different question. "Unknown command" is the truth and
 * tells an operator that the word means nothing, when it names the process this
 * whole machine exists to run; what they need is that it is started by something
 * other than them, and which something. That answer is complete on its own, so
 * the usage does not follow it: the usage is printed when the next step is to
 * pick a different word, and here it is not.
 *
 * The second sentence used to be two spellings of `systemctl status`, with a
 * clause about which one to use depending on how agentplex was installed. That
 * was the best answer available while `agentplex start` did not exist, and it
 * was still the operator being handed a decision -- user manager or system one
 * -- that this program can make for them out of the file the installer wrote.
 * Now it names the three commands that do it, and the scope stops being
 * something anybody has to know.
 */
function refuse(name: string): void {
  const unit = DAEMONS[name];
  if (unit !== undefined) {
    process.stderr.write(
      `agentplex: the ${name} is a daemon, not a command: this machine runs it under ${unit}.\n` +
        'agentplex: agentplex start enables and starts it, agentplex stop reverses that, and ' +
        'agentplex status says whether it is running.\n',
    );
  } else {
    process.stderr.write(`agentplex: unknown command ${JSON.stringify(name)}\n\n`);
    process.stderr.write(`${usage()}\n`);
  }
  process.exitCode = EXIT_BAD_COMMAND;
}

/**
 * Load a command and start it.
 *
 * Two lines, where there used to be a branch: a dispatched program was a URL
 * resolved against this file and handed to `import()` with the compiler told
 * nothing about the module at the far end, and there are none left. What is
 * here is a call -- the module was imported by a specifier TypeScript resolved
 * at build time, and `main()` is a function this file can see the type of.
 *
 * It is awaited, so a command that throws rejects here, at the bin's own top
 * level, exactly as it did when each of these was its own process with a
 * top-level `await main()` in it. Nothing is caught: a command sets
 * `process.exitCode` for every failure it has something to say about, and an
 * exception that reaches this point is the kind it did not anticipate, which
 * wants a stack trace and a non-zero exit rather than a tidier message that
 * hides where it came from.
 */
async function run(program: InAppCommand): Promise<void> {
  const loaded = await program.load();
  await loaded.main();
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
  } else if (asked !== undefined && asked.kind !== 'builtin') {
    process.argv.splice(2, 2, '--help');
    await run(asked);
  } else {
    process.stdout.write(`${usage()}\n`);
  }
}

/**
 * The notice, resolved now and called later, or `null` when there will not be
 * one.
 *
 * Everything it needs is composed here: the read-only filesystem, the detached
 * spawner, this identity's cache and the two process facts a refresh would be
 * re-run from. `process.argv[1]` is this file as the operator's shell resolved
 * it, which is what the background refresh has to name to be the same program.
 */
async function loadNotice(): Promise<(() => Promise<readonly string[]>) | null> {
  if (!NOTICE) return null;
  try {
    const [notice, files, providers, cache] = await Promise.all([
      import('./versions/update-notice.js'),
      import('./installation/node-installation-files.js'),
      import('@agentplex/providers'),
      import('./versions/versions-cache.js'),
    ]);
    const entrypoint = process.argv[1];
    if (entrypoint === undefined) return null;
    const dependencies = {
      files: files.nodeInstallationFiles,
      now: () => Date.now(),
      spawner: providers.createNodeDetachedSpawner({ environment: process.env }),
      cacheFile: cache.versionsCacheFile(process.env),
      runningVersion: await ownVersion(),
      interpreter: process.execPath,
      entrypoint,
    };
    return () => notice.updateNotice(dependencies);
  } catch {
    // A notice nobody asked for is not worth a failure. The likeliest cause is
    // the one this whole arrangement is about -- a package that moved under a
    // running process -- and the right answer to it is no line.
    return null;
  }
}

/** This package's version, or `null` for a tree that cannot say. */
async function ownVersion(): Promise<string | null> {
  try {
    return parseVersion(fileURLToPath(MANIFEST), await readFile(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

const command = process.argv[2];

if (command === '--help' || command === '-h') {
  process.stdout.write(`${usage()}\n`);
} else if (command === '--version') {
  // `-v` is not here, and its absence is a decision rather than an omission: it
  // is reserved for verbose, which is a flag several of these commands will
  // want and none of them has yet. A `-v` that printed a version would be the
  // hardest kind of thing to take back later -- somebody's script would be
  // parsing it -- so the word is kept free while it still costs nothing.

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
  // Loaded before the command, and called after it: see the note at the top.
  const notice = await loadNotice();

  if (program === undefined) {
    refuse(command);
  } else if (program.kind === 'builtin') {
    // `help` is the only one, and it is in the table so that the usage lists
    // it. What it does with the rest of argv is above.
    await help(process.argv[3]);
  } else {
    process.argv.splice(2, 1);
    await run(program);
  }

  if (notice !== null) {
    // stderr, always. On stdout this would end up inside somebody's `$(...)`.
    for (const line of await notice()) process.stderr.write(`agentplex: ${line}\n`);
  }
}
