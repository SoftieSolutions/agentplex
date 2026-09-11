import { describe, expect, it } from 'vitest';
import { PROGRAMS as PACKAGED } from '../packaging/assemble-package.js';
import { PROGRAMS } from './programs.js';

/**
 * The two lists of program names, held together by the only thing that can hold
 * them together here.
 *
 * `src/programs.ts` says what the bin dispatches to; `packaging/
 * assemble-package.ts` says whose `dist/` travels in the tarball. A fifth
 * program added to one and not the other produces a package that installs
 * cleanly and then answers `unknown command`, or a command that dispatches into
 * a path the tarball never carried.
 *
 * An import would be the stronger tie and is not available: `packaging/` sits
 * outside the build's `rootDir`, so a `src/` file importing it would move the
 * emitted entrypoint down a directory and break every relative path the bin
 * resolves. A test may import both, because tests are excluded from the build.
 */
describe('the program names', () => {
  it('are the same list the package is assembled from', () => {
    expect(Object.keys(PROGRAMS).sort()).toEqual([...PACKAGED].sort());
  });
});
