import { describe, expect, it } from 'vitest';
import { sessionDescriptorSchema, sessionStatusSchema, sessionUsageSchema } from './session.js';

const descriptor = {
  storeId: 'store-a',
  sessionId: 'session-a',
  provider: 'claude',
  status: 'awaiting-permission',
  updatedAt: 1_756_000_000_000,
  cwd: '/Users/dev/Code/agentplex',
  title: 'Docker compose without hub',
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

  it('refuses an empty cwd or title, so a blank cannot pass for a value', () => {
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, cwd: '' }).success).toBe(false);
    expect(sessionDescriptorSchema.safeParse({ ...descriptor, title: '' }).success).toBe(false);
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
