import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_COUNT_MAX,
  ACTIVITY_PATH_MAX_CHARS,
  ACTIVITY_TEXT_MAX_CHARS,
  activitySchema,
  displayableActivityText,
  TRANSCRIPT_ACTIVITIES_MAX,
} from './activity.js';

/** The key names `tests/hub-server` walks every frame to forbid. */
const FORBIDDEN_KEYS = ['args', 'argv', 'env', 'command', 'operation', 'pid', 'terminalId'];

describe('activitySchema', () => {
  it('carries a command as display text and, when the command ended, its exit status', () => {
    const parsed = activitySchema.safeParse({
      kind: 'command',
      text: "printf 'hello' > probe.txt",
      exitStatus: 0,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      kind: 'command',
      text: "printf 'hello' > probe.txt",
      exitStatus: 0,
    });
  });

  it('leaves the exit status off a command that has not ended', () => {
    const parsed = activitySchema.safeParse({ kind: 'command', text: 'pnpm check' });

    expect(parsed.success).toBe(true);
    expect(parsed.data && 'exitStatus' in parsed.data).toBe(false);
  });

  it('refuses an exit status outside the byte a wait status can hold', () => {
    for (const exitStatus of [0, 1, 255]) {
      expect(activitySchema.safeParse({ kind: 'command', text: 'x', exitStatus }).success).toBe(
        true,
      );
    }

    for (const exitStatus of [-1, 256, 1.5]) {
      expect(activitySchema.safeParse({ kind: 'command', text: 'x', exitStatus }).success).toBe(
        false,
      );
    }
  });

  it('carries an edit as the path label and, when they were counted, its line counts', () => {
    expect(
      activitySchema.safeParse({
        kind: 'edit',
        path: 'src/auth/refresh.ts',
        added: 18,
        removed: 4,
      }).success,
    ).toBe(true);

    // The counts are optional together and apart: an adapter that read the
    // path out of a transcript and no diffstat with it has a path to show.
    expect(activitySchema.safeParse({ kind: 'edit', path: 'src/auth/refresh.ts' }).success).toBe(
      true,
    );
    expect(
      activitySchema.safeParse({ kind: 'edit', path: 'src/auth/refresh.ts', added: 18 }).success,
    ).toBe(true);
  });

  it('refuses a negative count anywhere, because a count is a count', () => {
    expect(activitySchema.safeParse({ kind: 'edit', path: 'a.ts', added: -1 }).success).toBe(false);
    expect(activitySchema.safeParse({ kind: 'edit', path: 'a.ts', removed: -1 }).success).toBe(
      false,
    );
    expect(activitySchema.safeParse({ kind: 'tests', passed: -1 }).success).toBe(false);
    expect(activitySchema.safeParse({ kind: 'tests', failed: -1 }).success).toBe(false);
  });

  it('carries a test run whose counts are each their own optional fact', () => {
    expect(activitySchema.safeParse({ kind: 'tests', passed: 212, failed: 2 }).success).toBe(true);

    // No counts at all is a run that has reported none yet, which the kind
    // alone already says. Zeroes here would say every test passed.
    expect(activitySchema.safeParse({ kind: 'tests' }).success).toBe(true);
  });

  it('carries narration, an approval request and a plain line as text alone', () => {
    for (const kind of ['narration', 'approval', 'plain'] as const) {
      const parsed = activitySchema.safeParse({ kind, text: 'reading the auth module' });

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ kind, text: 'reading the auth module' });
    }
  });

  it('refuses a kind nobody defined, rather than drawing it as a plain line', () => {
    expect(activitySchema.safeParse({ kind: 'diff', text: 'a' }).success).toBe(false);
    expect(activitySchema.safeParse({ text: 'a' }).success).toBe(false);
  });

  it('refuses the fields of one variant on another', () => {
    expect(activitySchema.safeParse({ kind: 'plain', text: 'a', path: 'a.ts' }).success).toBe(
      false,
    );
    expect(activitySchema.safeParse({ kind: 'tests', text: 'a' }).success).toBe(false);
  });

  it('refuses every key name that would make this an execution surface', () => {
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(
        activitySchema.safeParse({ kind: 'command', text: 'ls', [forbidden]: 'ls' }).success,
        `${forbidden} was accepted onto an activity`,
      ).toBe(false);
    }
  });

  it('refuses a string longer than the bound, because this rides every scan', () => {
    const text = 'x'.repeat(ACTIVITY_TEXT_MAX_CHARS);

    expect(activitySchema.safeParse({ kind: 'plain', text }).success).toBe(true);
    expect(activitySchema.safeParse({ kind: 'plain', text: `${text}x` }).success).toBe(false);

    const path = 'p'.repeat(ACTIVITY_PATH_MAX_CHARS);

    expect(activitySchema.safeParse({ kind: 'edit', path }).success).toBe(true);
    expect(activitySchema.safeParse({ kind: 'edit', path: `${path}p` }).success).toBe(false);
  });

  it('refuses a line count past the stated maximum, so a count cannot be any number', () => {
    // The counts are the only unbounded numbers the union ever carried, and
    // `TRANSCRIPT_ACTIVITIES_MAX` is an arithmetic claim about the largest
    // variant -- which is this one. A count of arbitrary length would make that
    // sum a guess.
    expect(
      activitySchema.safeParse({ kind: 'edit', path: 'a.ts', added: ACTIVITY_COUNT_MAX }).success,
    ).toBe(true);
    expect(
      activitySchema.safeParse({ kind: 'edit', path: 'a.ts', removed: ACTIVITY_COUNT_MAX + 1 })
        .success,
    ).toBe(false);
    expect(
      activitySchema.safeParse({ kind: 'tests', passed: ACTIVITY_COUNT_MAX + 1 }).success,
    ).toBe(false);
    expect(
      activitySchema.safeParse({ kind: 'tests', failed: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(false);
  });

  /**
   * The reason `TRANSCRIPT_ACTIVITIES_MAX` is the number it is. Its comment
   * says a maximal answer is about a quarter of the socket's frame limit, and
   * that is arithmetic about JSON and UTF-8 rather than an opinion: this
   * measures it, over the largest variant rather than a chosen one. The ceiling
   * is `DEFAULT_MAX_PAYLOAD_BYTES` in `packages/node-shared/src/
   * ws-message-socket.ts`, spelled again here because this package may not
   * import another workspace package.
   */
  it('serialises a maximal answer as a frame the socket will carry', () => {
    const SOCKET_CEILING_BYTES = 1_000_000;
    const PER_ACTIVITY_BUDGET_BYTES = 1_300;
    const encoder = new TextEncoder();

    for (const [why, character] of [
      ['ascii', 'x'],
      ['a two-byte letter', 'д'],
      ['the worst of the Basic Multilingual Plane', '漢'],
      ['a quote, which JSON escapes', '"'],
    ] as const) {
      // Every variant, so the budget is measured against whichever is largest
      // rather than against the one the comment happens to name.
      const text = character.repeat(ACTIVITY_TEXT_MAX_CHARS);
      const path = character.repeat(ACTIVITY_PATH_MAX_CHARS);
      const every = [
        { kind: 'command', text, exitStatus: 255 },
        { kind: 'edit', path, added: ACTIVITY_COUNT_MAX, removed: ACTIVITY_COUNT_MAX },
        { kind: 'tests', passed: ACTIVITY_COUNT_MAX, failed: ACTIVITY_COUNT_MAX },
        { kind: 'narration', text },
        { kind: 'approval', text },
        { kind: 'plain', text },
      ];

      for (const activity of every) {
        expect(activitySchema.safeParse(activity).success, `${why}: ${activity.kind}`).toBe(true);
        expect(
          encoder.encode(JSON.stringify(activity)).length,
          `${why}: ${activity.kind}`,
        ).toBeLessThanOrEqual(PER_ACTIVITY_BUDGET_BYTES);
      }

      // And the whole answer, envelope included, against the socket's limit.
      const largest = every.reduce((worst, activity) =>
        JSON.stringify(activity).length > JSON.stringify(worst).length ? activity : worst,
      );
      const answer = {
        type: 'session-transcript-read',
        replyTo: 4096,
        activities: Array.from({ length: TRANSCRIPT_ACTIVITIES_MAX }, () => largest),
        olderExist: true,
      };

      expect(encoder.encode(JSON.stringify(answer)).length, why).toBeLessThan(
        SOCKET_CEILING_BYTES / 2,
      );
    }
  });

  it('strips the control and bidi characters out of every display string', () => {
    const parsed = activitySchema.safeParse({
      kind: 'command',
      text: '  pnpm\ttest\u0007 --‮flag\n',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ kind: 'command', text: 'pnpm test --flag' });

    const edit = activitySchema.safeParse({ kind: 'edit', path: 'src/‏auth.ts' });

    expect(edit.success).toBe(true);
    expect(edit.data).toEqual({ kind: 'edit', path: 'src/auth.ts' });
  });

  it('refuses a string with nothing left once it is stripped', () => {
    // An activity is a claim that something happened. A blank line drawn under
    // a session says that and shows none of it, so the adapter has to send no
    // activity instead -- which is what absence already means.
    expect(activitySchema.safeParse({ kind: 'plain', text: '' }).success).toBe(false);
    expect(activitySchema.safeParse({ kind: 'plain', text: ' \u0007‮ ' }).success).toBe(false);
    expect(activitySchema.safeParse({ kind: 'edit', path: '\u0000' }).success).toBe(false);
  });
});

describe('displayableActivityText', () => {
  it('turns the whitespace a transcript records into the single line this draws', () => {
    expect(displayableActivityText('editing\tsrc/auth/refresh.ts\r\n')).toBe(
      'editing src/auth/refresh.ts',
    );
    expect(displayableActivityText('two   spaces')).toBe('two spaces');
  });

  it('removes what would redraw the line rather than appear on it', () => {
    // A bidi override reorders what follows it, so a command shown through one
    // can read as a different command than the one that ran.
    expect(displayableActivityText('rm ‮txt.exe')).toBe('rm txt.exe');
    expect(displayableActivityText('bell\u0007 and \u009Bcsi')).toBe('bell and csi');
  });

  it('is idempotent, because a relayed activity is parsed again at each hop', () => {
    const once = displayableActivityText(' a\tb\u0007 c ');

    expect(displayableActivityText(once)).toBe(once);
  });
});
