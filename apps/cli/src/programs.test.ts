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
 * The tie is between the *dispatched* names, and that is the distinction `kind`
 * exists for rather than a reason to assert something weaker. A command the bin
 * answers out of its own process has no `dist/` to travel and belongs in
 * neither the packaged list nor a subset check that would quietly admit a
 * missing program alongside it. So both halves are asserted: every dispatched
 * name is packaged and every packaged name is dispatched, and `help` is named
 * here as the builtin it is, so adding a second one is a deliberate edit to
 * this file rather than a silent widening.
 *
 * An import in the shipped program would be the stronger tie and is not
 * available: the assembler is the repository's tooling and sits outside this
 * app entirely, so a `src/` file importing it would move the emitted
 * entrypoint down a directory and break every relative path the bin resolves.
 * A test may reach across, because tests are excluded from the build and this
 * one ships nowhere.
 */
function namesOfKind(kind: 'dispatched' | 'builtin'): readonly string[] {
  return Object.entries(PROGRAMS)
    .filter(([, program]) => program.kind === kind)
    .map(([name]) => name)
    .sort();
}

describe('the program names', () => {
  it('are the same list the package is assembled from', () => {
    expect(namesOfKind('dispatched')).toEqual([...PACKAGED].sort());
  });

  it('carry help as the one command the bin answers itself', () => {
    expect(namesOfKind('builtin')).toEqual(['help']);
    // And it is not packaged, because there is nothing of it to pack: it is
    // this bin's own code, already inside the entry the package carries.
    expect([...PACKAGED]).not.toContain('help');
  });
});
