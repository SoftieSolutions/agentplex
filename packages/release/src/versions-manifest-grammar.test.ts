import { describe, expect, it } from 'vitest';
import { isReleaseVersion } from './versions-manifest.js';

/**
 * The grammar a pin is refused against, which is `install.sh`'s
 * `RELEASE_VERSION` restated for the command that takes the same pins.
 *
 * The partial pin is the case worth writing down: `hub@1.3` is the shape a
 * fleet operator reaches for and it is refused, because a pin names a release
 * tag and this manifest describes only what is current. AGX-198 is the ticket
 * that would give the manifest history and make it resolvable.
 */
describe('isReleaseVersion', () => {
  it.each(['1.0.0', '0.0.1', '1.2.3-rc.1', '10.20.30', '1.2.3+build.5'])('accepts %s', (value) => {
    expect(isReleaseVersion(value)).toBe(true);
  });

  it.each(['1.3', '1', 'latest', 'v1.2.3', '', '1.2.3.4', '01.2.3'])('refuses %s', (value) => {
    expect(isReleaseVersion(value)).toBe(false);
  });
});
