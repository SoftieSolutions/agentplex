import { describe, expect, it } from 'vitest';
import { newestInSeries, readPin, resolvePin } from './pin.js';
import { SERIES_RESOLUTION_CASES } from './pin-cases.js';
import { updateVersionsManifest, type VersionsManifest } from './versions-manifest.js';

/**
 * The series resolver, over the rows `install.sh`'s suite resolves through the
 * script's `newest_in_series` -- see `pin-cases.ts`.
 */
describe('newestInSeries', () => {
  it.each(SERIES_RESOLUTION_CASES)('$name', ({ releases, series, expect: expected }) => {
    expect(newestInSeries(releases, series)).toBe(expected);
  });

  it('does not depend on the order it is handed the releases in', () => {
    expect(newestInSeries(['1.3.10', '1.3.2', '1.3.9'], '1.3')).toBe('1.3.10');
  });

  /** Build metadata is not a patch, so the depth the series fixes excludes it. */
  it('never resolves a series to a build', () => {
    expect(newestInSeries(['1.3.4', '1.3.5+build.1'], '1.3')).toBe('1.3.4');
  });

  it('has no opinion about a word that is not a series', () => {
    expect(newestInSeries(['1.3.0'], '1.3.0')).toBeNull();
    expect(newestInSeries(['1.3.0'], '1.')).toBeNull();
    expect(newestInSeries(['1.3.0'], '')).toBeNull();
  });
});

describe('readPin', () => {
  /** A prerelease named exactly is a tag, and a tag is not a series. */
  it('reads a prerelease named in full as an exact pin', () => {
    expect(readPin('1.3.8-rc1')).toEqual({ kind: 'exact', version: '1.3.8-rc1' });
  });
});

describe('resolvePin', () => {
  function entry(...versions: readonly string[]) {
    let manifest: VersionsManifest = {};
    for (const version of versions) {
      manifest = updateVersionsManifest(manifest, 'hub', { version, protocol: {} });
    }
    return manifest['hub'];
  }

  it('takes an exact pin as it is, listed or not', () => {
    expect(resolvePin({ kind: 'exact', version: '1.9.0' }, entry('1.2.0'))).toBe('1.9.0');
    expect(resolvePin({ kind: 'exact', version: '1.9.0' }, undefined)).toBe('1.9.0');
  });

  it('resolves a series against the releases the entry lists', () => {
    expect(resolvePin({ kind: 'series', series: '1.3' }, entry('1.3.9', '1.3.10', '1.4.0'))).toBe(
      '1.3.10',
    );
  });

  it('resolves a series against no entry to nothing', () => {
    expect(resolvePin({ kind: 'series', series: '1.3' }, undefined)).toBeNull();
  });
});
