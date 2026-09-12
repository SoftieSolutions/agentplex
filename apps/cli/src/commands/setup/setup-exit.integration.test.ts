import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerFixturePath } from '@agentplex/providers/testing';
import { nodePtyFactory, type Pty, type PtyExit } from '@agentplex/pty';

/**
 * `agentplex setup` on a real terminal, run to the end, and then: does it exit?
 *
 * Nothing below the process level can answer that. Every other test here drives
 * the terminal seam with a stream, and a stream ends — which is what makes a
 * piped run exit whether or not anything released the input. A tty never ends,
 * so an input left resumed holds the event loop open forever and the operator
 * gets a finished wizard and a prompt that never comes back. That is a real pty,
 * a real child, and an exit code or nothing.
 *
 * It runs the built bin, with the command word, because that is the artifact an
 * operator runs: there is no `apps/setup/dist/main.js` any more, and the wizard
 * was never reachable except through `agentplex setup`. The suite already
 * requires a build — the workspace's own tests resolve `@agentplex/protocol`
 * through its built declarations — so this adds no requirement that was not
 * already there.
 *
 * Nothing about what it proves moved with the entrypoint. The subject is still
 * a real pty, a real child and an exit code or nothing, and the extra argv
 * entry is consumed before the wizard reads argv at all. If anything the
 * question got sharper: the dispatcher now `await`s the wizard's `main()`
 * inside the bin's own process, so a handle the wizard failed to release holds
 * the bin open, and this is what would notice.
 *
 * `--role hub` on purpose in the first case: it is the shortest way to the last
 * question, and a hub plan touches no store, mints no identity and starts no
 * child, so what that one asserts is the terminal and nothing else.
 *
 * The second case is the one that lends the terminal out and takes it back. A
 * login is the only thing in setup that hands stdin to another program, puts it
 * in raw mode and resumes it directly, and every one of those is a way to end up
 * holding a handle nobody released. Asking whether the terminal comes back is
 * not the same question as asking whether it was ever given up, and only a
 * process that exits answers the second one.
 */

/**
 * A fork on a busy machine, and then a wizard. Generous, and still bounded.
 *
 * The test's own timeout is longer, so a run that never exits fails as "never
 * exited" with the child killed rather than as vitest giving up on a test that
 * has left a process behind.
 */
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;

/**
 * The built bin. Three levels up from this file is the app, and `dist` is
 * beside `src` under it.
 */
const BIN = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

/** The command word the bin consumes before the wizard reads argv. */
const COMMAND = 'setup';

const RETURN = '\r';

/**
 * The hub run's answers: role, hub port, apply, save. Every one takes the offer.
 *
 * Counted, and legitimately so. A hub plan runs no sessions, so the wizard asks
 * it nothing about providers — these four questions are the whole of a hub, and
 * registering a provider cannot add a fifth. The server run below is the one
 * that has to stop counting.
 */
const HUB_ANSWERS = RETURN.repeat(4);

/** What the operator pastes back from the browser, at the provider's own prompt. */
const CODE_FROM_THE_BROWSER = 'a-code-from-the-browser';

/** What a terminal starts a cursor move with. */
const ESCAPE = '\u001b';

/**
 * Everything a terminal writes to put the cursor somewhere, gone.
 *
 * Built rather than written as a literal: a control character in a regular
 * expression is banned in this repository, and it is banned for the reason that
 * makes this one worth a comment — nobody can see it in the source.
 */
const CURSOR = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, 'g');

/**
 * The question the child is sitting on, or nothing if it is still talking.
 *
 * A prompt is written without a newline, so it is whatever the child wrote after
 * the last one, with the cursor moves it drew it with taken out: `Role [server] `,
 * `codex [install] `, `Paste the code here: `.
 */
function pendingPrompt(text: string): string {
  const written = text.replaceAll(CURSOR, '');
  const last = written.split(/[\r\n]/).at(-1) ?? '';
  return last.trim().length === 0 ? '' : last;
}

/**
 * What a person sitting at this terminal would type at the question in front of
 * them, or nothing if they would not recognise it as a question.
 *
 * Answering the question rather than counting the questions. This test's subject
 * is whether the process exits, and the number of prompts between the start and
 * that exit is incidental to it — so it is not encoded here. Registering a
 * provider adds a question, and this keeps answering.
 *
 * The offer is taken everywhere but one place, and that one is the point of the
 * rule rather than an exception to it: a provider this machine does not have is
 * offered an install, and taking that offer would have the test npm-install a
 * provider out of the public registry to reach a login that is not its. The
 * `claude` on this run's PATH is the one being logged in, it is found, and what
 * it is offered is adoption.
 */
function asAnOperatorWould(prompt: string): string | undefined {
  if (prompt.startsWith('Paste the code here:')) return `${CODE_FROM_THE_BROWSER}${RETURN}`;
  if (prompt.endsWith('[install] ')) return `skip${RETURN}`;
  return prompt.endsWith('] ') ? RETURN : undefined;
}

let home: string;
/** A directory on the run's PATH, holding a `claude` and nothing else. */
let bin: string;

function fixture(name: string): string {
  return readFileSync(providerFixturePath(name), 'utf8').trim();
}

/**
 * A `claude` that answers the three questions setup puts to one, and signs in.
 *
 * A shell script rather than a mocked seam, because what is being asked is
 * whether a *process* exits, and everything between here and that answer has to
 * be real: a real pty, a real fork, a real login holding the terminal.
 *
 * What it prints for the two probes is the captured output in `fixtures/`, down
 * to the exit code 1 that 2.1.259 really returns while saying it is logged out.
 * The login half is the shape of the exchange rather than a capture: a real one
 * embeds a URL with a code in it, and a fixture of that is a fixture with a
 * secret in it. What matters here is that it reads a line from the terminal
 * before it will finish, which is the property that makes it a login at all.
 *
 * `CLAUDE_CONFIG_DIR` is where the signed-in marker lands, so the login writes
 * into the store setup told it about and the probe afterwards reads the same
 * place — which is what makes the probe's answer change at all.
 */
async function installFakeClaude(): Promise<void> {
  await writeFile(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'STATE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.signed-in"',
      `if [ "$1" = --version ]; then printf '%s\\n' '${fixture('claude-version.txt')}'; exit 0; fi`,
      'if [ "$1" = auth ] && [ "$2" = status ]; then',
      `  if [ -f "$STATE" ]; then printf '%s\\n' '${fixture('claude-auth-status-logged-in.json')}'; exit 0; fi`,
      `  printf '%s\\n' '${fixture('claude-auth-status-logged-out.json')}'; exit 1`,
      'fi',
      'if [ "$1" = auth ] && [ "$2" = login ]; then',
      '  printf "Paste the code here: "',
      '  read -r code',
      '  : > "$STATE"',
      '  printf "\\r\\nSigned in as $code.\\r\\n"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
    'utf8',
  );
  await chmod(join(bin, 'claude'), 0o755);
}

/**
 * Runs the built bin on a pty and answers the wizard, one question at a time.
 *
 * One at a time and never all at once, because a person types one line per
 * prompt and setup can tell the difference: answers that arrived ahead of the
 * questions are how it recognises a script behind a terminal and refuses to put
 * a browser OAuth flow in front of one. So the next line goes in only once the
 * child has stopped printing, which is what waiting for a prompt looks like from
 * out here.
 *
 * And then it answers what is actually on the screen. `answer` is handed the
 * prompt the run is sitting on and gives back what to type at it, so a question
 * this test did not know about is a question it can still answer rather than an
 * answer that lands one prompt early and a run that hangs behind it. Nothing to
 * type is nothing typed: the child stays where it is and the run fails as the
 * "never exited" it is, with the transcript saying which prompt stopped it.
 */
function driveOnAPty(
  args: readonly string[],
  answer: (prompt: string) => string | undefined,
): {
  readonly pty: Pty;
  readonly exited: Promise<PtyExit | 'never exited'>;
  readonly text: () => string;
} {
  const pty = nodePtyFactory.open({
    command: process.execPath,
    args: [BIN, COMMAND, ...args],
    cwd: home,
    // Everything the child is allowed to know about this machine, with this
    // test's own `claude` first on it.
    //
    // First is not tidiness. `dirname(process.execPath)` is `/usr/bin` on a
    // machine where node came from the distribution, which is also where a
    // developer's own `claude` lives — and setup adopts the copy that resolves
    // first, exactly as their shell would. Written the other way round, this
    // test drove the real Claude Code into a real browser OAuth flow and then
    // sat waiting for a code that was never going to be valid. That is the
    // adoption rule working, and it is also a test that reaches the internet and
    // fails on somebody's laptop for reasons that have nothing to do with the
    // change.
    env: { HOME: home, PATH: [bin, dirname(process.execPath)].join(delimiter) },
    cols: 80,
    rows: 24,
    term: 'xterm-256color',
  });

  const chunks: string[] = [];
  let quiet = 0;
  // How much had been printed when the last answer went in. Nothing new since
  // means the answer has not landed yet, and typing it twice would put the
  // second copy in front of the next question — the failure this test is
  // getting away from, arrived at from the other end.
  let answeredAt = -1;
  const typing = setInterval(() => {
    quiet += 1;
    if (quiet < 3) return;
    quiet = 0;
    const text = chunks.join('');
    if (text.length === answeredAt) return;
    const prompt = pendingPrompt(text);
    if (prompt.length === 0) return;
    const next = answer(prompt);
    if (next === undefined) return;
    answeredAt = text.length;
    pty.write(next);
  }, 50);
  pty.onData((chunk) => {
    quiet = 0;
    chunks.push(new TextDecoder().decode(chunk));
  });

  const exited = Promise.race([
    new Promise<PtyExit>((resolve) => pty.onExit(resolve)),
    new Promise<'never exited'>((resolve) =>
      setTimeout(() => resolve('never exited'), EXIT_TIMEOUT_MS),
    ),
  ]).finally(() => clearInterval(typing));

  return { pty, exited, text: () => chunks.join('') };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentplex-setup-exit-'));
  bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  // The store setup will offer, so there is one for a login to write into.
  await mkdir(join(home, '.claude'), { recursive: true });
  await installFakeClaude();
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('a finished setup run', () => {
  it(
    'exits when the terminal it was driven on has not ended',
    async () => {
      const pty = nodePtyFactory.open({
        command: process.execPath,
        args: [BIN, COMMAND, '--role', 'hub'],
        cwd: home,
        // Everything the child is allowed to know about this machine. `PATH` holds
        // the directory node is in and nothing else, so the survey finds no
        // provider and the run stays hermetic.
        env: { HOME: home, PATH: dirname(process.execPath) },
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      });

      const exited = new Promise<PtyExit>((resolve) => pty.onExit(resolve));

      // Written once the child has produced something, so the answers reach a
      // program that is already reading rather than a pty nobody has opened yet.
      let answered = false;
      pty.onData(() => {
        if (answered) return;
        answered = true;
        pty.write(HUB_ANSWERS);
      });

      const outcome = await Promise.race([
        exited,
        new Promise<'never exited'>((resolve) =>
          setTimeout(() => resolve('never exited'), EXIT_TIMEOUT_MS),
        ),
      ]);

      // Killed either way: a test that leaves a child behind on failure is a
      // test that makes the next run stranger than this one.
      pty.kill();

      expect(outcome).toEqual({ exitCode: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits after a run that lent the terminal to a provider login',
    async () => {
      // A login is the only thing in setup that hands stdin to another program,
      // makes it raw and resumes it directly, so it is the one path that can end
      // holding a handle nobody released — and a terminal that came back
      // working still holds the process open if nothing unrefs it. The first
      // case cannot see that: it never lends the terminal out.
      //
      // `--role server`: no hub port to answer, and every question that is left
      // is one the login step depends on.
      const driven = driveOnAPty(['--role', 'server'], asAnOperatorWould);

      const outcome = await driven.exited;
      driven.pty.kill();

      // The transcript on failure, because a run that never exited is a run
      // that stopped somewhere, and where is the whole of the answer.
      expect(outcome, driven.text()).toEqual({ exitCode: 0, signal: null });
      // And it was a login that happened, rather than a question that was
      // skipped: the provider's prompt reached the operator's terminal, the
      // pasted code reached the provider, and the re-probe afterwards saw the
      // machine the login had changed.
      expect(driven.text()).toContain('Paste the code here:');
      expect(driven.text()).toContain(`Signed in as ${CODE_FROM_THE_BROWSER}`);
      expect(driven.text()).toContain('claude is logged in.');
    },
    TEST_TIMEOUT_MS,
  );
});
