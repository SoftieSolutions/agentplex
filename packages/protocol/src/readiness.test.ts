import { describe, expect, it } from 'vitest';
import { providerReadinessSchema, readinessRefusal, type ProviderReadiness } from './readiness.js';

const READY = {
  provider: 'claude',
  state: 'ready',
  version: '2.1.259',
  directory: '/home/robert/.local/bin',
  problem: null,
};

describe('providerReadinessSchema', () => {
  it('accepts a provider that resolved, reported a version and is logged in', () => {
    const parsed = providerReadinessSchema.safeParse(READY);

    expect(parsed.success).toBe(true);
  });

  it('accepts a provider nothing on the search path holds', () => {
    const parsed = providerReadinessSchema.safeParse({
      provider: 'claude',
      state: 'missing',
      version: null,
      directory: null,
      problem: 'no directory this server searches holds claude',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a state that is not one of the four', () => {
    // "installed" would be somebody's reasonable guess and means nothing here:
    // a hub branches on this word to decide whether to refuse a start.
    const parsed = providerReadinessSchema.safeParse({ ...READY, state: 'installed' });

    expect(parsed.success).toBe(false);
  });

  it('refuses a provider name this protocol does not know', () => {
    const parsed = providerReadinessSchema.safeParse({ ...READY, provider: 'gemini' });

    expect(parsed.success).toBe(false);
  });

  it('refuses an empty directory rather than reading it as "somewhere"', () => {
    // An empty string is a resolution that failed wearing the shape of one that
    // did not, and it would be drawn as a blank where a path belongs.
    const parsed = providerReadinessSchema.safeParse({ ...READY, directory: '' });

    expect(parsed.success).toBe(false);
  });

  it('requires every field, so a partial reading cannot be published as a whole one', () => {
    const parsed = providerReadinessSchema.safeParse({ provider: 'claude', state: 'ready' });

    expect(parsed.success).toBe(false);
  });
});

function readiness(fields: Partial<ProviderReadiness>): ProviderReadiness {
  return providerReadinessSchema.parse({ ...READY, ...fields });
}

describe('readinessRefusal', () => {
  it('lets a ready provider through', () => {
    expect(readinessRefusal(readiness({}))).toBeNull();
  });

  it('refuses a provider nothing holds, in the words the server used', () => {
    const problem = 'no directory this server searches holds claude';

    expect(
      readinessRefusal(readiness({ state: 'missing', version: null, directory: null, problem })),
    ).toBe(problem);
  });

  it('refuses a provider that says it is logged out', () => {
    expect(readinessRefusal(readiness({ state: 'unauthenticated', problem: 'log in first' }))).toBe(
      'log in first',
    );
  });

  it('lets a provider through whose probes could not answer', () => {
    // The binary resolved, so a start is not the pty that dies. Refusing here
    // would turn "could not tell" into "no" and take a working provider offline
    // the first time its vendor renames a subcommand.
    expect(
      readinessRefusal(readiness({ state: 'unknown', problem: 'claude printed no version' })),
    ).toBeNull();
  });

  it('still refuses when the server named no problem', () => {
    expect(
      readinessRefusal(
        readiness({ state: 'missing', version: null, directory: null, problem: null }),
      ),
    ).toBe('that server cannot run claude');
  });
});
