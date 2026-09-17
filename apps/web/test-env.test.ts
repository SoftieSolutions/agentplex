import { describe, expect, it } from 'vitest';

import { TEST_CREDENTIAL_VARIABLES, TEST_ENVIRONMENT_PINS } from '../../scripts/test-env.js';

/**
 * The same claim `scripts/test-env.test.ts` makes, asked in the one package
 * that does not run under the shared config.
 *
 * It is here rather than trusted because this package reaching the pins is a
 * separate line of code in a separate file, and the failure it guards against
 * is silent in both directions: a pin that never ran leaves every date test
 * passing on the laptop that wrote it, and a `vite.config.ts` edited for some
 * unrelated reason can drop the call without anything else noticing.
 *
 * It sits beside `vite.config.ts`, which is the file under test.
 */
describe('the browser suite environment', () => {
  it('carries every pin', () => {
    for (const [name, value] of Object.entries(TEST_ENVIRONMENT_PINS)) {
      expect(process.env[name], `${name} is not pinned for this run`).toBe(value);
    }
  });

  it('is in UTC as far as the date engine is concerned', () => {
    // Asked of the engine and not of the variable: a pin applied after the
    // worker started would set the second and leave the first alone.
    expect(new Date('2024-01-15T12:00:00Z').getTimezoneOffset()).toBe(0);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });

  it('carries no provider credential', () => {
    // The other half of the one call `vite.config.ts` makes. This package
    // spawns nothing, so a leaked key could not reach a provider from here --
    // but the claim being checked is that this call site got the whole
    // decision and not just the pins, and that is what a dropped call breaks.
    for (const name of TEST_CREDENTIAL_VARIABLES) {
      expect(process.env[name], `${name} is visible to this run`).toBeUndefined();
    }
  });

  it('formats a local timestamp as the UTC one', () => {
    // The shape a component rendering a session's `updatedAt` would take.
    const at = new Date('2024-01-15T23:30:00Z');

    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()]).toEqual([
      2024, 0, 15, 23,
    ]);
  });
});
