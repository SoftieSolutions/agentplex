import { describe, expect, it } from 'vitest';
import { createFakeProviderAdapter } from './fake-provider-adapter.js';
import { createProviderRegistry } from './provider-registry.js';

describe('createProviderRegistry', () => {
  it('answers with the adapter registered for a provider name', () => {
    const claude = createFakeProviderAdapter({ provider: 'claude' });
    const registry = createProviderRegistry([claude]);

    const lookup = registry.lookup('claude');

    expect(lookup).toEqual({ ok: true, adapter: claude });
  });

  it('refuses a name that is not a provider at all', () => {
    const registry = createProviderRegistry([createFakeProviderAdapter({ provider: 'claude' })]);

    const lookup = registry.lookup('cursor');

    expect(lookup).toMatchObject({ ok: false, reason: 'unknown-provider' });
  });

  it('refuses a value that is not even a name', () => {
    const registry = createProviderRegistry([createFakeProviderAdapter({ provider: 'claude' })]);

    for (const name of [42, null, undefined, { provider: 'claude' }, ['claude']]) {
      expect(registry.lookup(name)).toMatchObject({ ok: false, reason: 'unknown-provider' });
    }
  });

  it('distinguishes a provider this build cannot drive from a name it does not know', () => {
    // The protocol names codex and opencode because a session frame must be
    // able to say what it is; this build ships no adapter for either. A caller
    // that has to tell "not a provider" from "not implemented here" must not do
    // it by matching on a message.
    const registry = createProviderRegistry([createFakeProviderAdapter({ provider: 'claude' })]);

    expect(registry.lookup('codex')).toMatchObject({ ok: false, reason: 'no-adapter' });
    expect(registry.lookup('opencode')).toMatchObject({ ok: false, reason: 'no-adapter' });
  });

  it('says which providers it can actually drive, not which ones exist', () => {
    const registry = createProviderRegistry([createFakeProviderAdapter({ provider: 'claude' })]);

    expect(registry.providers).toEqual(['claude']);
    expect(registry.adapters).toHaveLength(1);
  });

  it('has nothing to drive when nothing is registered', () => {
    const registry = createProviderRegistry([]);

    expect(registry.providers).toEqual([]);
    expect(registry.lookup('claude')).toMatchObject({ ok: false, reason: 'no-adapter' });
  });

  it('refuses to be built with two adapters claiming one provider', () => {
    // A wiring mistake, not a claim off the wire: the last-one-wins registry
    // would silently run whichever adapter was constructed second.
    expect(() =>
      createProviderRegistry([
        createFakeProviderAdapter({ provider: 'claude' }),
        createFakeProviderAdapter({ provider: 'claude' }),
      ]),
    ).toThrow(/claude/);
  });
});
