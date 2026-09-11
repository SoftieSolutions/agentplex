import { describe, expect, it } from 'vitest';
import { DAEMONS as PACKAGED } from '../../../scripts/assemble-package.js';
import { DAEMONS, PROGRAMS } from './programs.js';

/**
 * Two tables in this app and one in the packaging script, and what is left to
 * tie together now that a daemon is not a command.
 *
 * The tie this file used to hold was between the *dispatched* names here and
 * the packaged list in `scripts/assemble-package.ts`: a program added to one
 * and not the other produced a package that installed cleanly and then answered
 * `unknown command`, or a command that dispatched into a path the tarball never
 * carried. Nothing dispatches by path any more, so that failure cannot happen
 * and that assertion has nothing to assert. Deleting it and stopping there
 * would be wrong for a different reason: the two lists did not stop existing,
 * they stopped being the same list, and *that* is the thing worth pinning down.
 *
 * So three invariants, and each is a decision somebody made rather than a shape
 * the code happens to have.
 *
 * **The sets are disjoint.** This is the whole of the decision: `hub` and
 * `server` are daemons started by systemd or by `pnpm start`, and there is to be
 * no way to type either at this bin. A name in `PROGRAMS` that the package also
 * ships as a daemon is that decision being undone, whether on purpose or by
 * somebody restoring a line they thought was an oversight.
 *
 * **The bin answers for every daemon the package carries, and for no other
 * name.** `DAEMONS` exists so that `agentplex hub` says what a hub is instead of
 * `unknown command`, and a daemon the package ships that this table has never
 * heard of gets the useless answer for the one name most likely to be typed. In
 * the other direction, a name here that the package does not ship is this bin
 * telling an operator to go look at a unit for a daemon that is not installed.
 * This is the drift check the old one becomes: still against the packaged list,
 * about a different table, guarding a different failure.
 *
 * **The kinds partition the command table.** A fourth kind would be in
 * `PROGRAMS`, listed by `--help`, and named by none of the assertions below --
 * which is the exact drift this file exists to stop.
 *
 * Written out rather than derived, as before: `setup` becoming a separate app
 * again, or a third builtin appearing, is a real decision about how this bin is
 * put together and should cost a deliberate edit to this file.
 *
 * An import in the shipped program would be the stronger tie and is not
 * available: the assembler is the repository's tooling and sits outside this app
 * entirely, so a `src/` file importing it would move the emitted entrypoint down
 * a directory and break every relative path the bin resolves. A test may reach
 * across, because tests are excluded from the build and this one ships nowhere.
 */
function namesOfKind(kind: 'command' | 'builtin'): readonly string[] {
  return Object.entries(PROGRAMS)
    .filter(([, program]) => program.kind === kind)
    .map(([name]) => name)
    .sort();
}

describe('the program names', () => {
  it('share not one name with the daemons the package ships, because a daemon is not a command', () => {
    const both = Object.keys(PROGRAMS).filter((name) => PACKAGED.includes(name));
    expect(both).toEqual([]);
    // And named, so that the failure above reads as the decision it is rather
    // than as an empty array that was supposed to stay empty for some reason.
    expect(Object.keys(PROGRAMS)).not.toContain('hub');
    expect(Object.keys(PROGRAMS)).not.toContain('server');
  });

  it('answer for every daemon the package ships, and for no name it does not', () => {
    expect(Object.keys(DAEMONS).sort()).toEqual([...PACKAGED].sort());
  });

  it('name a unit for each daemon, which is the whole of what the answer is worth', () => {
    // A message that says "this is a daemon" and stops has told an operator
    // nothing they can act on. The unit name is the next step, so it is the
    // part that is asserted.
    for (const [daemon, unit] of Object.entries(DAEMONS)) {
      expect(unit).toBe(`agentplex-${daemon}.service`);
    }
  });

  it('carry the five commands this app holds, and no daemon among them', () => {
    expect(namesOfKind('command')).toEqual(['doctor', 'setup', 'start', 'status', 'stop']);
    // None of them is packaged as a daemon: every one is a module under the
    // entry the package already carries, so there is no `apps/setup/dist` to
    // pack and no `apps/start/dist` either.
    for (const name of namesOfKind('command')) expect([...PACKAGED]).not.toContain(name);
  });

  it('keep start, stop and status as commands, which is the point of them', () => {
    // `agentplex start` exists so that nobody has to know whether their units
    // belong to the user manager or the system one. That makes it the one
    // command in this table whose whole subject is the daemons -- and the
    // reason it is still not a way to *run* one: it asks systemd, and the
    // disjointness assertion above is what keeps `hub` from creeping back in
    // beside it.
    for (const name of ['start', 'stop', 'status']) {
      expect(Object.keys(PROGRAMS)).toContain(name);
    }
  });

  it('carry help as the one command the bin answers itself', () => {
    expect(namesOfKind('builtin')).toEqual(['help']);
    expect([...PACKAGED]).not.toContain('help');
  });

  it('are all of one of those two kinds, so nothing escapes the checks above', () => {
    expect([...namesOfKind('command'), ...namesOfKind('builtin')].sort()).toEqual(
      Object.keys(PROGRAMS).sort(),
    );
  });
});
