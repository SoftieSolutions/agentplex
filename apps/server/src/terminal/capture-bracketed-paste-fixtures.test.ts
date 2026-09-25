import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { systemClock, randomIdGenerator } from '@agentplex/node-shared';
import { nodePtyFactory, createPtySupervisor } from '@agentplex/pty';
import type { Launch } from '@agentplex/providers';

/**
 * Captures a real line editor turning bracketed paste on, chunked exactly as a
 * pty delivered it. The web pane's paste test replays it.
 *
 * What that test pins is which bytes a paste puts on the wire, and the answer
 * depends on a mode the program at the far end sets: with bracketed paste on,
 * a terminal wraps pasted text in `ESC[200~` and `ESC[201~` so the program can
 * tell a paste from typing and refuse to run half of it on the first newline.
 * Whether this pane's emulator is in that mode is decided by parsing bytes
 * somebody else sent, so a fixture of bytes written here by hand would be this
 * repository asking itself a question it had already answered. These come off
 * a shell that really sets the mode, through a real pty.
 *
 * `zsh -f -i` rather than a script that prints `ESC[?2004h` itself: the point
 * of the capture is that a program nobody here wrote asks for the mode as part
 * of putting a line editor up, which is the situation a user pastes into. `-f`
 * skips every startup file, so the bytes are the shell's own and not this
 * machine's configuration. bash is not the alternative it looks like: macOS
 * ships bash 3.2, which predates readline's bracketed paste entirely.
 *
 * `PS1` and `PROMPT_EOL_MARK` are set for the same reason the unicode capture
 * uses `printf` rather than an agent: zsh's default prompt is `%m%#`, which
 * would put the capturing machine's hostname in a committed fixture, and its
 * default end-of-line mark repaints the line with a reverse-video marker that
 * varies with how the pty happened to flush. Neither is what is under test.
 *
 * Recording stops while the shell is still waiting for a line, before `exit`
 * is sent. That is deliberate and is the whole shape of the fixture: zsh turns
 * the mode back off (`ESC[?2004l`) the moment it accepts a line, so a capture
 * that ran to the child's exit would replay into an emulator that ends with
 * bracketed paste off -- the opposite of the state the test needs to be in.
 *
 * A test file so it runs under vitest (the one runner here that resolves `.js`
 * specifiers to `.ts` sources); gated on an environment variable so an
 * ordinary run never rewrites the fixture. To re-capture, from apps/server:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run src/capture-bracketed-paste-fixtures.test.ts
 */

const CHILD_TIMEOUT_MS = 20_000;
/** Long enough for a shell to start and draw a prompt, short enough to wait for. */
const PROMPT_MS = 1_500;

/** `ESC[?2004h`: bracketed paste on. What this capture exists to contain. */
const BRACKETED_PASTE_ON = `${String.fromCharCode(27)}[?2004h`;
/** `ESC[?2004l`: off again. What it exists not to contain. */
const BRACKETED_PASTE_OFF = `${String.fromCharCode(27)}[?2004l`;

describe.runIf(process.env.CAPTURE_FIXTURES === '1')('capturing bracketed paste fixtures', () => {
  it('runs a real shell on a real pty and writes what it printed before the prompt', async () => {
    const supervisor = createPtySupervisor({
      pty: nodePtyFactory,
      clock: systemClock,
      ids: randomIdGenerator,
      environment: {
        PATH: process.env.PATH ?? '',
        // A prompt that is the same on every machine, and no end-of-line mark.
        PS1: 'pane$ ',
        PROMPT_EOL_MARK: '',
      },
    });
    const launch: Launch = {
      ok: true,
      plan: {
        command: 'zsh',
        args: ['-f', '-i'],
        cwd: process.cwd(),
        env: {},
        scrubEnvPrefixes: [],
      },
    };

    const started = supervisor.launch(launch);
    if (!started.ok) throw new Error(`the launch was refused: ${started.problem}`);
    const run = started.run;

    const chunks: Uint8Array[] = [];
    const stop = run.subscribe((chunk) => chunks.push(Uint8Array.from(chunk)));

    await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_MS));
    // Everything after this point is the shell tidying up after a line it was
    // given, which includes turning the mode back off.
    stop();
    run.write('exit\r');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the child never exited')), CHILD_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (run.exit === null) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }, 10);
    });

    const all = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    // A shell with no line editor, or one that never got as far as a prompt,
    // would write a fixture that proves nothing.
    expect(all).toContain(BRACKETED_PASTE_ON);
    // And the mode has to still be on at the end of the replay.
    expect(all).not.toContain(BRACKETED_PASTE_OFF);

    // Single quotes, matching prettier, so a re-capture leaves a clean tree.
    const entries = chunks
      .map((chunk) => `  '${Buffer.from(chunk).toString('base64')}',`)
      .join('\n');
    const module = `/**
 * A real shell putting its line editor up, chunked exactly as a pty delivered
 * it, and stopping while it was still waiting for a line.
 *
 * Generated by apps/server/src/terminal/capture-bracketed-paste-fixtures.test.ts (see
 * that file for how to re-run the capture, and for why it is a shell rather
 * than a script printing the sequence itself). Never edited by hand: what the
 * pane's paste test reads off these bytes is whether the emulator ends up in
 * bracketed paste mode, and hand-written bytes would carry their author's
 * answer to that already.
 *
 * Replaying these leaves an emulator with bracketed paste ON, which is the
 * state a paste has to be wrapped in. The shell turns it off again as soon as
 * it accepts a line, so the capture stops before that.
 *
 * Base64 rather than byte arrays so the file stays reviewable; decoded here
 * with atob, which exists in every browser and in the node vitest runs on.
 */

function decode(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const encoded: readonly string[] = [
${entries}
];

/** Oldest first, boundaries preserved. Callers must not mutate the arrays. */
export const bracketedPasteChunks: readonly Uint8Array[] = encoded.map(decode);
`;

    const target = new URL('../../../web/src/terminal/bracketed-paste.fixture.ts', import.meta.url);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, module, 'utf8');
    process.stdout.write(`wrote ${String(chunks.length)} chunks to ${fileURLToPath(target)}\n`);
  });
});
