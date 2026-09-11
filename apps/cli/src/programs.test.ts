import { describe, expect, it } from 'vitest';
import { PROGRAMS as PACKAGED } from '../../../scripts/assemble-package.js';
import { PROGRAMS } from './programs.js';

/**
 * The two lists of program names, held together by the only thing that can hold
 * them together here.
 *
 * `src/programs.ts` says what the bin dispatches to; `scripts/
 * assemble-package.ts` says whose `dist/` travels in the tarball. A program
 * added to one and not the other produces a package that installs cleanly and
 * then answers `unknown command`, or a command that dispatches into a path the
 * tarball never carried.
 *
 * The tie is between the *dispatched* names, and that is the distinction `kind`
 * exists for rather than a reason to assert something weaker. Neither of the
 * other two kinds has a `dist/` of its own to travel: a builtin is this bin's
 * own code, and an in-app command is a module inside `apps/cli/dist`, which the
 * packaged list does not name because the entry carrying it is named already.
 * So both halves are asserted -- every dispatched name is packaged and every
 * packaged name is dispatched -- and the names of the other two kinds are
 * written out here as well.
 *
 * Written out, rather than derived: a subset check would quietly admit a
 * missing program, and a partition check that only counted would quietly admit
 * a command that changed kind. `setup` becoming dispatched again, or a third
 * builtin appearing, is a real decision about how this bin is put together, and
 * it should cost a deliberate edit to this file. That is the same bargain the
 * `builtin` half was written under; a third kind does not loosen it.
 *
 * An import in the shipped program would be the stronger tie and is not
 * available: the assembler is the repository's tooling and sits outside this
 * app entirely, so a `src/` file importing it would move the emitted
 * entrypoint down a directory and break every relative path the bin resolves.
 * A test may reach across, because tests are excluded from the build and this
 * one ships nowhere.
 */
function namesOfKind(kind: 'dispatched' | 'command' | 'builtin'): readonly string[] {
  return Object.entries(PROGRAMS)
    .filter(([, program]) => program.kind === kind)
    .map(([name]) => name)
    .sort();
}

describe('the program names', () => {
  it('are the same list the package is assembled from', () => {
    expect(namesOfKind('dispatched')).toEqual([...PACKAGED].sort());
  });

  it('carry setup and doctor as commands this app holds', () => {
    expect(namesOfKind('command')).toEqual(['doctor', 'setup']);
    // And neither is packaged, because there is no `apps/setup/dist` to pack
    // any more: both are modules under the entry the package already carries.
    expect([...PACKAGED]).not.toContain('setup');
    expect([...PACKAGED]).not.toContain('doctor');
  });

  it('carry help as the one command the bin answers itself', () => {
    expect(namesOfKind('builtin')).toEqual(['help']);
    // And it is not packaged, because there is nothing of it to pack: it is
    // this bin's own code, already inside the entry the package carries.
    expect([...PACKAGED]).not.toContain('help');
  });

  it('are all of one of those three kinds, so nothing escapes the two checks above', () => {
    // The partition, asserted rather than assumed. Without it a fourth kind
    // would be in the table, listed by `--help`, and named by none of the
    // assertions above -- which is the exact drift this file exists to stop.
    expect(
      [...namesOfKind('dispatched'), ...namesOfKind('command'), ...namesOfKind('builtin')].sort(),
    ).toEqual(Object.keys(PROGRAMS).sort());
  });
});
