import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Run a command and fail if anything outside the workspace and the temporary
 * directory changed while it ran.
 *
 * `scripts/test-home.ts` gives every suite a throwaway `$HOME`, which is the
 * fix; this is the thing that keeps the fix true. A property that holds because
 * nine files currently happen to respect it is a property that stops holding
 * the next time somebody writes a test that spawns the real bin and builds the
 * child's environment by hand -- the failure is silent, lands in the
 * contributor's own `~/.claude` or `~/.agentplex`, and shows up as a test that
 * passes on their machine and nowhere else. A check that only a person running
 * the suite with fresh eyes would notice is not a check.
 *
 * ## Snapshot and compare, rather than take away the permission
 *
 * The other way to enforce this is to run the suite as a user who can write
 * nowhere but the temporary root. It states the rule more strongly -- the write
 * fails rather than being noticed afterwards -- and it is the wrong trade here.
 * The suite legitimately writes into the workspace (coverage, vite's cache) and
 * into the store the container image owns, so the unprivileged user would need
 * a list of exceptions maintained in the Dockerfile, and the failure a
 * contributor would read is an `EACCES` from whichever library happened to open
 * the file. Comparing two walks costs a couple of seconds and can say which
 * path appeared and which test was running when it did, which is the difference
 * between a guard somebody acts on and a guard somebody disables.
 *
 * ## What is inside the sandbox
 *
 * The workspace, because the suite builds in it, and `$TMPDIR`, because the
 * throwaway homes live there and because the suites make their own temporary
 * directories beside them. `$TMPDIR` wholesale rather than the one root
 * `test-home-root.ts` makes: that root's name is chosen inside the vitest
 * process and never crosses back out, and a guard that had to know it would be
 * a guard coupled to the internals of the file it protects. What is left is
 * every path a leak actually damages -- the operator's home, `/etc`, the
 * installed toolchain -- and in the container, where this runs, `$TMPDIR` is
 * thrown away with the container anyway.
 *
 * The kernel's own filesystems are skipped because they change on their own:
 * `/proc` and `/sys` differ between two walks of an idle machine, and `/dev`
 * grows a pty for every terminal the server's suites open.
 *
 * ## The container only
 *
 * `docker-compose.test.yml` wires this into the `test` service, which is what
 * CI runs and what `pnpm docker:test` runs. A native `pnpm test` is untouched,
 * deliberately: a laptop's `/` is neither disposable nor quiet -- a browser, a
 * sync client and an editor all write during the seconds the suite takes -- so
 * the guard would report their writes as the suite's and be believed once.
 */

/** The directory the vitest reports are written to, which is how a leak is dated. */
export const TEST_TIMINGS = 'AGENTPLEX_TEST_TIMINGS';

/** Paths that change on their own, or whose owner is not the suite. */
const KERNEL_FILESYSTEMS = ['/proc', '/sys', '/dev'];

/** How many paths a failure lists before it starts counting instead. */
const LISTED = 50;

export type Kind = 'file' | 'directory' | 'symlink' | 'other';

export interface Entry {
  readonly kind: Kind;
  readonly size: number;
  readonly mtimeMs: number;
}

/** What one walk found: every path under the root, against what it looked like. */
export type Snapshot = ReadonlyMap<string, Entry>;

export type Change =
  | { readonly kind: 'added'; readonly path: string; readonly at: number }
  | { readonly kind: 'changed'; readonly path: string; readonly at: number }
  | { readonly kind: 'removed'; readonly path: string };

/** When one test file was running, so that a leak's timestamp can name it. */
export interface TestWindow {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Walk `root`, descending into nothing named in `skipped`.
 *
 * Synchronous and depth-first, with `lstat` rather than `stat`: a symlink is
 * recorded as itself and never followed, so a link into a skipped directory
 * cannot walk the guard back into it, and a link that dangles is an entry
 * rather than an error.
 *
 * A directory that cannot be read costs itself and not the walk. The
 * alternative is a guard that fails the suite because one path in `/var` was
 * momentarily unreadable, which is the shape of check that gets deleted.
 */
export function snapshotTree(root: string, skipped: ReadonlySet<string>): Snapshot {
  const found = new Map<string, Entry>();
  const pending = [root];

  for (;;) {
    const directory = pending.pop();
    if (directory === undefined) break;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (skipped.has(path)) continue;

      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }

      const kind = entryKind(stats.isDirectory(), stats.isFile(), stats.isSymbolicLink());
      found.set(path, { kind, size: stats.size, mtimeMs: stats.mtimeMs });
      if (kind === 'directory') pending.push(path);
    }
  }

  return found;
}

function entryKind(directory: boolean, file: boolean, symlink: boolean): Kind {
  if (symlink) return 'symlink';
  if (directory) return 'directory';
  if (file) return 'file';
  return 'other';
}

/**
 * What the second walk found that the first did not, sorted by path so that two
 * runs of the same leak read the same.
 *
 * Size and modification time, not contents: a file rewritten with the same
 * bytes in the same second is a leak this cannot see, and hashing every file
 * on the machine twice to catch it would cost more than the case is worth.
 *
 * A directory whose modification time moved because something appeared in it is
 * left out, because it is the same news twice: writing `/root/leak` restamps
 * `/root`, and a tree of ten files would otherwise arrive as twenty lines with
 * the ones a person can act on mixed in among them. A directory that changed
 * with nothing of its own to explain it is still reported -- that is a rename
 * or a deletion the walk did not otherwise see.
 */
export function compareSnapshots(before: Snapshot, after: Snapshot): readonly Change[] {
  const changes: Change[] = [];
  const directories = new Set<string>();

  for (const [path, entry] of after) {
    const was = before.get(path);
    if (was === undefined) {
      changes.push({ kind: 'added', path, at: entry.mtimeMs });
      continue;
    }
    if (was.kind !== entry.kind || was.size !== entry.size || was.mtimeMs !== entry.mtimeMs) {
      changes.push({ kind: 'changed', path, at: entry.mtimeMs });
      if (entry.kind === 'directory') directories.add(path);
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ kind: 'removed', path });
  }

  const explained = new Set(
    changes.filter((change) => change.kind !== 'changed').map((change) => dirname(change.path)),
  );

  return changes
    .filter((change) => !(directories.has(change.path) && explained.has(change.path)))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * The subset of a vitest JSON report this reads: one window per test file.
 *
 * A report is a file another program wrote, so it is parsed rather than
 * trusted. Everything else in it -- the assertions, the snapshot counts -- is
 * the run's own business and the reporter that already printed it.
 */
const reportSchema = z.object({
  testResults: z.array(z.object({ name: z.string(), startTime: z.number(), endTime: z.number() })),
});

export function parseTestWindows(source: string, text: string): readonly TestWindow[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${String(error)}`);
  }

  const report = reportSchema.safeParse(document);
  if (!report.success) {
    throw new Error(`${source} is not a vitest report: ${report.error.message}`);
  }

  return report.data.testResults.map((result) => ({
    file: result.name,
    start: result.startTime,
    end: result.endTime,
  }));
}

/**
 * The test files that were running at `at`.
 *
 * Plural because `pnpm test` is `pnpm -r test`: the members run in parallel and
 * so do the files inside each one, so at any instant several are in flight.
 * Naming all of them is a short list somebody can read; naming one of them
 * would be a guess wearing the clothes of an answer.
 */
export function ranAt(windows: readonly TestWindow[], at: number): readonly string[] {
  return windows.filter((window) => window.start <= at && at <= window.end).map(({ file }) => file);
}

/** The failure a contributor reads, which has to be specific enough to act on. */
export function describeChanges(input: {
  readonly changes: readonly Change[];
  readonly windows: readonly TestWindow[];
  readonly startedAt: number;
  readonly workspaceRoot: string;
}): string {
  const { changes, windows, startedAt, workspaceRoot } = input;
  const count = changes.length;
  const lines = [
    `test-write-guard: ${count} ${count === 1 ? 'path' : 'paths'} outside the workspace and ` +
      `the temporary directory changed while the suite ran.`,
    '',
  ];

  for (const change of changes.slice(0, LISTED)) {
    lines.push(`  ${change.kind.padEnd(8)}${change.path}`);
    if (change.kind === 'removed') continue;

    const seconds = ((change.at - startedAt) / 1000).toFixed(1);
    const running = ranAt(windows, change.at).map((file) => relative(workspaceRoot, file));
    if (running.length === 0) {
      lines.push(`          ${seconds}s into the run, when no test file was running`);
      continue;
    }
    lines.push(`          ${seconds}s into the run, while these test files were running:`);
    for (const file of running) lines.push(`            ${file}`);
  }

  if (count > LISTED) lines.push(`  and ${count - LISTED} more`);

  lines.push(
    '',
    'A test writes under the home it was given and under the temporary directory,',
    'and nowhere else. scripts/test-home.ts hands every suite a throwaway $HOME;',
    'a spawn that builds its own environment has to carry $HOME into it, because',
    'a child with no $HOME resolves the real one out of the passwd entry.',
  );

  return lines.join('\n');
}

/** Every vitest report the run left behind, and a note for any that could not be read. */
function readTestWindows(directory: string): { windows: TestWindow[]; notes: string[] } {
  const windows: TestWindow[] = [];
  const notes: string[] = [];

  let reports: string[];
  try {
    reports = readdirSync(directory);
  } catch (error) {
    return { windows, notes: [`no test timings: ${String(error)}`] };
  }

  for (const report of reports) {
    const path = join(directory, report);
    try {
      windows.push(...parseTestWindows(path, readFileSync(path, 'utf8')));
    } catch (error) {
      notes.push(String(error));
    }
  }

  return { windows, notes };
}

function run(command: string, args: readonly string[], timings: string): Promise<number> {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, [TEST_TIMINGS]: timings },
    });
    child.on('error', fail);
    child.on('close', (code, signal) => settle(signal !== null ? 128 : (code ?? 1)));
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    process.stderr.write('usage: node scripts/test-write-guard.ts <command> [args...]\n');
    process.exitCode = 2;
    return;
  }

  const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const temporary = resolve(process.env['TMPDIR'] ?? '/tmp');
  const skipped = new Set([workspaceRoot, temporary, ...KERNEL_FILESYSTEMS]);
  // Inside `$TMPDIR`, so that the reports the guard asks for are not themselves
  // a difference the guard reports.
  const timings = mkdtempSync(join(temporary, 'agentplex-test-timings-'));

  try {
    const before = snapshotTree('/', skipped);
    const startedAt = Date.now();
    const code = await run(command, args, timings);
    const after = snapshotTree('/', skipped);

    const changes = compareSnapshots(before, after);
    if (changes.length === 0) {
      process.exitCode = code;
      return;
    }

    const { windows, notes } = readTestWindows(timings);
    process.stderr.write(`\n${describeChanges({ changes, windows, startedAt, workspaceRoot })}\n`);
    for (const note of notes) process.stderr.write(`  ${note}\n`);
    process.exitCode = code === 0 ? 1 : code;
  } finally {
    rmSync(timings, { recursive: true, force: true });
  }
}

// Imported by its test; executed by the `test` service in docker-compose.test.yml.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
