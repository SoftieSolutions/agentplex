import { describe, expect, it } from 'vitest';
import { sessionDescriptorSchema, sessionStatusSchema } from './session.js';

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
