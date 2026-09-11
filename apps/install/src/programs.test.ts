import { describe, expect, it } from 'vitest';
import { PROGRAMS as PACKAGED } from '../../../scripts/assemble-package.js';
import { PROGRAMS } from './programs.js';

/**
 * The two lists of program names, held together by the only thing that can hold
 * them together here.
 *
 * `src/programs.ts` says what the bin dispatches to; `scripts/
 * assemble-package.ts` says whose `dist/` travels in the tarball. A fifth
 * program added to one and not the other produces a package that installs
 * cleanly and then answers `unknown command`, or a command that dispatches into
 * a path the tarball never carried.
 *
 * An import in the shipped program would be the stronger tie and is not
 * available: the assembler is the repository's tooling and sits outside this
 * app entirely, so a `src/` file importing it would move the emitted
 * entrypoint down a directory and break every relative path the bin resolves.
 * A test may reach across, because tests are excluded from the build and this
 * one ships nowhere.
 */
describe('the program names', () => {
  it('are the same list the package is assembled from', () => {
    expect(Object.keys(PROGRAMS).sort()).toEqual([...PACKAGED].sort());
  });
});
