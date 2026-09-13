import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { systemClock, randomIdGenerator } from '@agentplex/node-shared';
import { nodePtyFactory, createPtySupervisor } from '@agentplex/pty';
import type { Launch } from '@agentplex/providers';

/**
 * Captures a real program drawing a bordered panel whose contents are wide:
 * CJK, an emoji, an emoji ZWJ sequence, box drawing. The web pane's Unicode
 * width test replays it.
 *
 * What that test pins is a column count, and a column count is exactly the
 * thing a hand-written fixture cannot establish. The panel below is padded by
 * the program that draws it on the assumption every modern terminal makes --
 * an emoji is two columns wide -- so whether the right border lands in one
 * column on all three rows is a fact about the emulator's width table and
 * nothing else. Bytes typed into a fixture by hand would carry the author's
 * assumption about the padding as well, and prove only that the two
 * assumptions matched.
 *
 * Captured from a shell rather than from a coding agent. An agent's first
 * screen is real output, but it is not this: it carries the machine's home
 * directory, the signed-in account and the agent's version, it differs with
 * whether that directory has been trusted yet, and no prompt makes it print a
 * chosen glyph at a chosen column. `printf` prints exactly the bytes asked
 * for, on any machine, which is what a fixture that anybody can re-capture
 * needs. The pty, the chunk boundaries and the UTF-8 encoding are real either
 * way -- that is what running it under a pty is for.
 *
 * The glyphs appear as octal escapes rather than as themselves so that this
 * file keeps the repository's no-emoji rule. The fixture it writes does carry
 * one, because the emoji is the thing under test.
 *
 * A test file so it runs under vitest (the one runner here that resolves `.js`
 * specifiers to `.ts` sources); gated on an environment variable so an
 * ordinary run never rewrites the fixture. To re-capture, from apps/server:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run src/capture-unicode-width-fixtures.test.ts
 */

const CHILD_TIMEOUT_MS = 20_000;

/** ESC, for the SGR runs that colour the border the way a TUI colours one. */
const ESC = '\\033';
/** U+2500 through U+2518: the box-drawing characters, one column each. */
const HORIZONTAL = '\\342\\224\\200';
const VERTICAL = '\\342\\224\\202';
const TOP_LEFT = '\\342\\224\\214';
const TOP_RIGHT = '\\342\\224\\220';
const BOTTOM_LEFT = '\\342\\224\\224';
const BOTTOM_RIGHT = '\\342\\224\\230';
/** U+65E5 U+672C U+8A9E: three CJK ideographs, two columns each. */
const CJK = '\\346\\227\\245\\346\\234\\254\\350\\252\\236';
/** U+1F9D1, U+200D, U+1F4BB: the halves of one emoji ZWJ sequence. */
const PERSON = '\\360\\237\\247\\221';
const ZWJ = '\\342\\200\\215';
const LAPTOP = '\\360\\237\\222\\273';

const DIM = `${ESC}[38;5;245m`;
const RESET = `${ESC}[0m`;

/**
 * A twelve-column panel, padded for a two-column emoji, then the ZWJ sequence
 * on a line of its own with a border character behind it as a ruler.
 *
 * The `sleep`s are what make the pty hand the reader more than one chunk: a
 * single burst can arrive as one read, and a fixture with one chunk exercises
 * no boundary at all. Newlines are bare `\n`; the pty's own ONLCR turns each
 * into the carriage return and line feed a terminal receives.
 */
const DRAWING = [
  `printf '${DIM}${TOP_LEFT}${HORIZONTAL} ${CJK} ${HORIZONTAL}${TOP_RIGHT}${RESET}\\n'`,
  'sleep 0.05',
  `printf '${DIM}${VERTICAL}${RESET} ${PERSON} ok    ${DIM}${VERTICAL}${RESET}\\n'`,
  'sleep 0.05',
  `printf '${DIM}${BOTTOM_LEFT}${HORIZONTAL.repeat(10)}${BOTTOM_RIGHT}${RESET}\\n'`,
  'sleep 0.05',
  `printf '${PERSON}${ZWJ}${LAPTOP}${DIM}${VERTICAL}${RESET}\\n'`,
].join('; ');

describe.runIf(process.env.CAPTURE_FIXTURES === '1')('capturing unicode width fixtures', () => {
  it('runs a real pty and writes every chunk it delivered', async () => {
    const supervisor = createPtySupervisor({
      pty: nodePtyFactory,
      clock: systemClock,
      ids: randomIdGenerator,
      environment: { PATH: process.env.PATH ?? '' },
    });
    const launch: Launch = {
      ok: true,
      plan: {
        command: '/bin/sh',
        args: ['-c', DRAWING],
        cwd: process.cwd(),
        env: {},
        scrubEnvPrefixes: [],
      },
    };

    const started = supervisor.launch(launch);
    if (!started.ok) throw new Error(`the launch was refused: ${started.problem}`);
    const run = started.run;

    const chunks: Uint8Array[] = [];
    run.subscribe((chunk) => chunks.push(Uint8Array.from(chunk)));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the child never exited')), CHILD_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (run.exit === null) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }, 10);
    });

    // A shell whose printf does not speak octal escapes would write the
    // escapes themselves, which is a fixture of nothing. The emoji's four
    // bytes are the ones to check for: they are the widest thing here.
    const all = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    expect(all.includes(Buffer.from([0xf0, 0x9f, 0xa7, 0x91]))).toBe(true);
    // A one-chunk capture exercises no chunk boundary; the sleeps above exist
    // to prevent it, and this catches the platform where they did not.
    expect(chunks.length).toBeGreaterThan(3);

    // Single quotes, matching prettier, so a re-capture leaves a clean tree.
    const entries = chunks
      .map((chunk) => `  '${Buffer.from(chunk).toString('base64')}',`)
      .join('\n');
    const module = `/**
 * A real program drawing a bordered panel of wide characters, chunked exactly
 * as a pty delivered it.
 *
 * Generated by apps/server/src/capture-unicode-width-fixtures.test.ts (see
 * that file for how to re-run the capture, and for why it is a shell rather
 * than a coding agent doing the drawing). Never edited by hand: what the
 * pane's Unicode test reads off these bytes is which column each glyph ends
 * in, and hand-written bytes would carry their author's answer to that
 * question already.
 *
 * The panel is padded by the program that drew it for a two-column emoji, so
 * its right border is in one column on every row only if the emulator
 * measures that emoji the way the program did. These bytes contain an emoji,
 * which nothing else in this repository does: it is the thing under test.
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
export const unicodeChunks: readonly Uint8Array[] = encoded.map(decode);
`;

    const target = new URL('../../web/src/terminal/unicode-widths.fixture.ts', import.meta.url);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, module, 'utf8');
    process.stdout.write(`wrote ${String(chunks.length)} chunks to ${fileURLToPath(target)}\n`);
  });
});
