import { describe, expect, it } from 'vitest';
import { readPin } from './pin.js';
import { PIN_GRAMMAR_CASES } from './pin-cases.js';
import { isReleaseVersion } from './versions-manifest.js';

/**
 * The grammar a pin is read against, over the table `install.sh`'s suite runs
 * too -- see `pin-cases.ts`. A row that reads one way here and another way in
 * the script is a red test on one side of the pair.
 */
describe('readPin', () => {
  const exact = PIN_GRAMMAR_CASES.filter((one) => one.kind === 'exact');
  const series = PIN_GRAMMAR_CASES.filter((one) => one.kind === 'series');
  const refused = PIN_GRAMMAR_CASES.filter((one) => one.kind === 'refused');

  it.each(exact)('reads $word as an exact release', ({ word }) => {
    expect(isReleaseVersion(word)).toBe(true);
    expect(readPin(word)).toEqual({ kind: 'exact', version: word });
  });

  it.each(series)('reads $word as a series', ({ word }) => {
    expect(isReleaseVersion(word)).toBe(false);
    expect(readPin(word)).toEqual({ kind: 'series', series: word });
  });

  it.each(refused)('refuses $word', ({ word }) => {
    expect(isReleaseVersion(word)).toBe(false);
    expect(readPin(word)).toBeNull();
  });
});
