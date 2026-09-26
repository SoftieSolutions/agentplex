import { describe, expect, it } from 'vitest';
import { NODE_NAME_MAX_CHARS } from './layout.js';
import {
  boundedSessionText,
  SESSION_BRANCH_MAX_CHARS,
  SESSION_CWD_MAX_CHARS,
  SESSION_MODEL_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  sessionDescriptorSchema,
  sessionHoldSchema,
  sessionPauseSchema,
  sessionStatusSchema,
  sessionUsageSchema,
  UNCOMMITTED_FILES_LISTED,
  uncommittedDiffSchema,
} from './session.js';

const descriptor = {
  storeId: 'store-a',
  sessionId: 'session-a',
  provider: 'claude',
  status: 'awaiting-permission',
  updatedAt: 1_756_000_000_000,
  cwd: '/Users/dev/Code/agentplex',
  branch: 'fix/auth-refresh',
  title: 'Docker compose without hub',
  uncommitted: {
    files: 3,
    added: 42,
    removed: 5,
    entries: [
      { path: 'src/auth/refresh.ts', added: 18, removed: 4 },
      { path: 'src/auth/refresh.test.ts', added: 22, removed: 0 },
      { path: 'src/auth/index.ts', added: 2, removed: 1 },
    ],
  },
};

describe('sessionDescriptorSchema', () => {
  it('describes a session by its store, its id within it, and its provider', () => {
    const parsed = sessionDescriptorSchema.safeParse(descriptor);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(descriptor);
  });

  it('takes null for a label the provider does not record, but not a missing key', () => {
    // Nullable, not optional. "The adapter looked and the provider says
    // nothing" and "nobody filled this in" are different facts, and only the
    // first one is safe to render as an empty cell.
    expect(
      sessionDescriptorSchema.safeParse({ ...descriptor, cwd: null, title: null }).success,
    ).toBe(true);

    const { cwd: _cwd, ...withoutCwd } = descriptor;
    expect(sessionDescriptorSchema.safeParse(withoutCwd).success).toBe(false);
  });

  it('takes a session with no usage on it at all, and leaves it that way', () => {
    // Optional, alone on this descriptor, and not a lapse. "The provider
    // counted no tokens for this session" and "whatever reported this does not
    // count tokens" are the same fact to everything downstream: there is no
    // number to show. A `cwd` earns its nullability because a reader acts on
    // the difference; this one does not.
    const parsed = sessionDescriptorSchema.safeParse(descriptor);

    expect(parsed.success).toBe(true);
    expect(parsed.data && 'usage' in parsed.data).toBe(false);
  });

  it('never turns an absent usage into a zeroed one', () => {
    // The rule the whole feature is built to keep. A default here would make
    // "we do not know what this cost" arrive downstream as "this was free",
    // which is the direction that over-claims, on the one screen where the
    // number is something a person budgets against.
    const parsed = sessionDescriptorSchema.parse(descriptor);

    expect(parsed.usage).toBeUndefined();
  });

  it('carries the four token buckets a price has to be applied to separately', () => {
    const usage = {
      inputTokens: 2,
      cacheReadTokens: 24_372,
      cacheWriteTokens: 18_438,
      outputTokens: 206,
    };

    expect(sessionDescriptorSchema.parse({ ...descriptor, usage }).usage).toEqual(usage);
  });

  it('refuses a usage record that states only some of its buckets', () => {
    // Three of four is not a partial answer, it is a wrong one: whatever
    // prices this would read the missing bucket as zero and bill a cache read
    // at nothing. A provider that cannot break its total down this way reports
    // no usage instead.
    expect(
      sessionDescriptorSchema.safeParse({ ...descriptor, usage: { inputTokens: 2 } }).success,
    ).toBe(false);
  });

  it('takes a session with no model on it, and does not invent one', () => {
    // Optional for the reason `usage` is: an adapter that looked and found no
    // model, and a report from something that does not name models, are the
    // same fact downstream -- there is nothing to show. What is never allowed
    // is a default, because the provider's usual model is a guess dressed as a
    // reading, and the segment that names it would then be confidently wrong.
    const parsed = sessionDescriptorSchema.safeParse(descriptor);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.model).toBeUndefined();
  });

  it('carries the model the provider stated, as the string it stated', () => {
    // A string and not a union. The set of models is the providers' to change
    // and not this repository's to enumerate: a model that shipped this morning
    // has to arrive at the client without a release here, so nothing parses
    // this into a closed set and nothing downstream switches on the value.
    expect(sessionDescriptorSchema.parse({ ...descriptor, model: 'opus-4.1' }).model).toBe(
      'opus-4.1',
    );
  });

  it('refuses a model that is not a string, or is an empty one', () => {
    // The parser is where a claim off another program's record is checked. A
    // number means the adapter read the wrong field, and an empty string is a
    // present-but-blank value that would render as a stray separator with
    // nothing between it -- both are absence stated wrongly, and absence has
    // its own spelling here.
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, model: 5 }).success).toBe(false);
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, model: '' }).success).toBe(false);
  });

  it('takes an activity, and an absent one is absence rather than an empty line', () => {
    const withActivity = {
      ...descriptor,
      activity: { kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 },
    };
    const parsed = sessionDescriptorSchema.safeParse(withActivity);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(withActivity);

    // Optional, as `usage` and `model` are. An adapter that derived no activity
    // sends no field, and the client draws nothing -- not a blank plain line,
    // which would claim the session said something and then show none of it.
    const bare = sessionDescriptorSchema.safeParse(descriptor);

    expect(bare.success).toBe(true);
    expect(bare.data && 'activity' in bare.data).toBe(false);
  });

  it('refuses a descriptor whose activity the activity parser refuses', () => {
    // One parser, reached through the descriptor: nothing here re-states what
    // an activity is, and a kind nobody defined costs the frame rather than
    // arriving as a session with an unreadable line under it.
    for (const activity of [
      { kind: 'diff', text: 'a' },
      { kind: 'command', text: 'ls', command: 'ls' },
      { kind: 'tests', passed: -1 },
      { kind: 'plain', text: '' },
      null,
    ]) {
      expect(sessionDescriptorSchema.safeParse({ ...descriptor, activity }).success).toBe(false);
    }
  });

  it('refuses an empty cwd, branch or title, so a blank cannot pass for a value', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, cwd: '' }).success).toBe(false);
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, branch: '' }).success).toBe(false);
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, title: '' }).success).toBe(false);
  });

  it('takes null for a branch, whether the head is detached or nobody read it', () => {
    // One value for both, deliberately. Unlike the diffstat below, the two ways
    // of having no branch draw the same thing and neither claims anything about
    // the checkout, so there is nothing for a client to tell apart.
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, branch: null }).success).toBe(true);

    const { branch: _branch, ...withoutBranch } = descriptor;
    expect(sessionDescriptorSchema.safeParse(withoutBranch).success).toBe(false);
  });

  it('refuses a session that names no provider', () => {
    const { provider: _provider, ...withoutProvider } = descriptor;

    expect(sessionDescriptorSchema.safeParse(withoutProvider).success).toBe(false);
  });

  it('refuses a provider name this protocol does not know', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, provider: 'cursor' }).success).toBe(
      false,
    );
  });

  it('refuses a status outside the closed set a client can render', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, status: 'busy' }).success).toBe(
      false,
    );
  });

  it('refuses an updatedAt that is not a whole epoch millisecond', () => {
    for (const updatedAt of ['1756000000000', 1.5, -1, null]) {
      expect(sessionDescriptorSchema.safeParse({ ...descriptor, updatedAt }).success).toBe(false);
    }
  });

  it('refuses an empty session id, so a missing id cannot read as a session', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, sessionId: '' }).success).toBe(false);
  });
});

describe('the free-text strings on a descriptor', () => {
  // Every one of these is somebody else's word -- a provider's transcript, a
  // git ref -- riding on a frame that carries every session in a store and is
  // sent again on every scan. A bound on each is what keeps one session's
  // oddity from being a cost the whole fleet pays, and the bound is checked
  // here at the parser that every hop runs.
  it('takes each string at its bound', () => {
    const atBound = {
      ...descriptor,
      title: 't'.repeat(SESSION_TITLE_MAX_CHARS),
      model: 'm'.repeat(SESSION_MODEL_MAX_CHARS),
      branch: 'b'.repeat(SESSION_BRANCH_MAX_CHARS),
      cwd: `/${'c'.repeat(SESSION_CWD_MAX_CHARS - 1)}`,
    };

    expect(sessionDescriptorSchema.parse(atBound)).toEqual(atBound);
  });

  it('refuses each string one past its bound', () => {
    for (const over of [
      { title: 't'.repeat(SESSION_TITLE_MAX_CHARS + 1) },
      { model: 'm'.repeat(SESSION_MODEL_MAX_CHARS + 1) },
      { branch: 'b'.repeat(SESSION_BRANCH_MAX_CHARS + 1) },
      { cwd: `/${'c'.repeat(SESSION_CWD_MAX_CHARS)}` },
    ]) {
      expect(sessionDescriptorSchema.safeParse({ ...descriptor, ...over }).success).toBe(false);
    }
  });

  it('refuses a title or model that is nothing but characters that cannot be drawn', () => {
    // The same pipe an activity's text goes through, for the same reason: a
    // string of control and bidi characters draws as nothing, and a title that
    // draws as nothing is absence spelled as a value.
    for (const blank of ['\u202e\u2066', '\u0007\u001b', ' \t ']) {
      expect(sessionDescriptorSchema.safeParse({ ...descriptor, title: blank }).success).toBe(
        false,
      );
      expect(sessionDescriptorSchema.safeParse({ ...descriptor, model: blank }).success).toBe(
        false,
      );
    }
  });

  it('draws a title and a model without the characters that reorder or control a line', () => {
    const parsed = sessionDescriptorSchema.parse({
      ...descriptor,
      title: 'Fix\u202e the\tlogin',
      model: 'opus\u0007-4.1',
    });

    expect(parsed.title).toBe('Fix the login');
    expect(parsed.model).toBe('opus-4.1');
  });

  it('bounds a title by the name a catalogue node may carry, which is what it becomes', () => {
    expect(SESSION_TITLE_MAX_CHARS).toBeLessThanOrEqual(NODE_NAME_MAX_CHARS);
  });
});

describe('boundedSessionText', () => {
  it('passes a displayable string within the bound through unchanged', () => {
    expect(boundedSessionText('Docker compose without hub', 200)).toBe(
      'Docker compose without hub',
    );
  });

  it('clips a string past the bound to a prefix the schema takes', () => {
    const clipped = boundedSessionText('word '.repeat(100), SESSION_TITLE_MAX_CHARS);

    expect(clipped).not.toBeNull();
    expect(clipped?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    // Clipped at a space and re-trimmed, so the parse on the other side does
    // not move it: what the server sends is what the client draws.
    expect(clipped).toBe(clipped?.trim());
    expect(sessionDescriptorSchema.parse({ ...descriptor, title: clipped }).title).toBe(clipped);
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    // The bound counts UTF-16 units, as the schema does, but the cut is made
    // between code points: a lone surrogate is not a character anybody wrote.
    const clipped = boundedSessionText(`a${'\u{1f600}'.repeat(10)}`, 4) ?? '';

    expect(clipped).toBe('a\u{1f600}');
    expect(clipped.length).toBeLessThanOrEqual(4);
  });

  it('strips what cannot be drawn before it measures', () => {
    expect(boundedSessionText(`\u202e${'x'.repeat(10)}`, 10)).toBe('x'.repeat(10));
  });

  it('answers null when nothing drawable survives', () => {
    expect(boundedSessionText('\u202e\u2066\u0007', 10)).toBeNull();
    expect(boundedSessionText('', 10)).toBeNull();
  });
});

describe('sessionUsageSchema', () => {
  it('keeps cached input in its own bucket, because it is priced in its own right', () => {
    // Not itemisation for its own sake. A cache read is billed around a tenth
    // of fresh input and a cache write above it, so collapsing the three into
    // one "input" number does not lose precision -- it produces a figure
    // several times the real cost for any session long enough to be worth
    // looking at.
    expect(Object.keys(sessionUsageSchema.shape).sort()).toEqual([
      'cacheReadTokens',
      'cacheWriteTokens',
      'inputTokens',
      'outputTokens',
    ]);
  });

  it('takes zero, because a provider that counted and found none said something', () => {
    const none = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };

    expect(sessionUsageSchema.safeParse(none).success).toBe(true);
  });

  it('refuses a negative or fractional count, which no provider states', () => {
    const usage = {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };

    expect(sessionUsageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
    expect(sessionUsageSchema.safeParse({ ...usage, outputTokens: 1.5 }).success).toBe(false);
  });
});

describe('sessionStatusSchema', () => {
  it('carries a value for "the provider did not say", so no status has to be guessed', () => {
    expect(sessionStatusSchema.safeParse('unknown').success).toBe(true);
  });

  it('names the two states that want a human, separately from the ones that do not', () => {
    expect(sessionStatusSchema.safeParse('awaiting-permission').success).toBe(true);
    expect(sessionStatusSchema.safeParse('awaiting-input').success).toBe(true);
    expect(sessionStatusSchema.safeParse('working').success).toBe(true);
    expect(sessionStatusSchema.safeParse('idle').success).toBe(true);
  });
});

describe('uncommittedDiffSchema', () => {
  const diff = {
    files: 1,
    added: 18,
    removed: 4,
    entries: [{ path: 'src/auth/refresh.ts', added: 18, removed: 4 }],
  };

  it('is the uncommitted sense of "changed" and says so by being the only one', () => {
    // The field a client reads is named for what it is. There is no branch
    // diffstat beside it and no flag that would turn this into one: "changed"
    // means two things about a repository, and a schema that could carry either
    // under one name is a screen where two numbers that disagree are both
    // labelled the same.
    expect(uncommittedDiffSchema.safeParse(diff).success).toBe(true);
    expect(Object.keys(uncommittedDiffSchema.shape).sort()).toEqual([
      'added',
      'entries',
      'files',
      'removed',
    ]);
  });

  it('takes null counts for a file git would not count, but never a negative one', () => {
    // A binary. `null` is git declining; `0` would be git having counted and
    // found nothing, which is a different claim about the same file.
    expect(
      uncommittedDiffSchema.safeParse({
        ...diff,
        entries: [{ path: 'assets/logo.png', added: null, removed: null }],
      }).success,
    ).toBe(true);

    expect(
      uncommittedDiffSchema.safeParse({
        ...diff,
        entries: [{ path: 'src/a.ts', added: -1, removed: 0 }],
      }).success,
    ).toBe(false);
  });

  it('takes a null path, so a name that cannot be represented costs its name only', () => {
    expect(
      uncommittedDiffSchema.safeParse({
        ...diff,
        entries: [{ path: null, added: 2, removed: 0 }],
      }).success,
    ).toBe(true);

    // Nullable, not empty. A blank name would be drawn as a file called
    // nothing rather than as a file whose name this cannot show.
    expect(
      uncommittedDiffSchema.safeParse({
        ...diff,
        entries: [{ path: '', added: 2, removed: 0 }],
      }).success,
    ).toBe(false);
  });

  it('refuses a list longer than the bound, because the totals carry the whole count', () => {
    const row = { path: 'src/a.ts', added: 1, removed: 0 };
    const entries = Array.from({ length: UNCOMMITTED_FILES_LISTED + 1 }, () => row);

    expect(uncommittedDiffSchema.safeParse({ ...diff, entries }).success).toBe(false);
    expect(
      uncommittedDiffSchema.safeParse({ ...diff, entries: entries.slice(0, -1) }).success,
    ).toBe(true);
  });

  it('is nullable on a descriptor, because "nobody looked" is not "nothing changed"', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, uncommitted: null }).success).toBe(
      true,
    );

    // Nullable and not optional, for the reason `cwd` is: a field nobody filled
    // in and a server that looked and could not read are different facts, and
    // only one of them is safe to draw as an empty cell.
    const { uncommitted: _uncommitted, ...withoutDiff } = descriptor;
    expect(sessionDescriptorSchema.safeParse(withoutDiff).success).toBe(false);
  });
});

describe('sessionHoldSchema', () => {
  it('carries how paused the held session is, in one of three words', () => {
    for (const pause of ['none', 'requested', 'paused'] as const) {
      expect(
        sessionHoldSchema.safeParse({ sessionId: 'session-1', stoppable: true, pause }).success,
      ).toBe(true);
    }
    expect(sessionPauseSchema.options).toEqual(['none', 'requested', 'paused']);
  });

  it('rejects a hold with no answer about pausing, rather than assuming none', () => {
    // Absence is not `none`. A server that does not say is a server on another
    // protocol, and the version check should have refused it; a default here
    // would let a reader show "running" for a session that is in fact paused.
    expect(sessionHoldSchema.safeParse({ sessionId: 'session-1', stoppable: true }).success).toBe(
      false,
    );
    expect(
      sessionHoldSchema.safeParse({ sessionId: 'session-1', stoppable: true, pause: 'pausing' })
        .success,
    ).toBe(false);
  });
});
