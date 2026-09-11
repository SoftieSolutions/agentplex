/**
 * What the `agentplex` bin answers to, by name.
 *
 * Two kinds of command, and a third table beside them that is not commands at
 * all.
 *
 * An **in-app command** is ordinary code in this app, reached by a real import
 * that the compiler checks like any other. `setup` and `doctor` live under
 * `src/commands/`, so there is no boundary to cross and nothing to be careful
 * about: renaming an export breaks the build here rather than at runtime on
 * somebody's machine.
 *
 * `load` is a thunk returning a dynamic `import()` of a static specifier, which
 * is both: lazy, so `agentplex doctor` never evaluates the wizard's module graph
 * and vice versa, and typechecked, because the specifier is a literal the
 * compiler can resolve. A bare eager import at the top of this file would pull
 * both graphs into every run of the bin, `--version` included.
 *
 * A **builtin** is `help`, which has no program behind it at all: the bin
 * answers it itself, out of this same table. It is in the table rather than
 * beside it so that `agentplex --help` lists it, and a command nothing lists is
 * a command nobody finds.
 *
 * ## There was a third kind, and it is gone
 *
 * A **dispatched** program was another app's build artifact, reached by path and
 * never by import: `hub` and `server` were `../../hub/dist/main.js` and
 * `../../server/dist/main.js`, handed to `import()` with TypeScript deliberately
 * told nothing about what was at the far end. That kind is not narrowed here, it
 * is deleted, because its whole membership left the table at once -- and the
 * consequence is worth more than the lines it takes away.
 *
 * A daemon is not a command. Nobody types `agentplex hub`, in any form: systemd
 * starts the two daemons from their units in production and `pnpm start` does it
 * in development, and neither route comes through this bin. So this app no
 * longer reaches into another app's build output at all, and AGENTS.md's
 * "nothing imports an app" holds here by construction rather than by discipline
 * -- there is no untypechecked `import()` of a sibling `dist/` left for a later
 * edit to point somewhere new. What remains is a table of modules this app owns,
 * every one of them resolved by the compiler.
 *
 * `DAEMONS` below is what is left of the two names, and it is deliberately not
 * `PROGRAMS`: the bin keeps the words so that it can say what they are rather
 * than shrug at them, which is a different job from running something.
 *
 * It is its own module so that a test can read it: `main.ts` dispatches at
 * module top level, and importing that file is running the bin.
 */
export type Program = InAppCommand | BuiltinCommand;

/**
 * A command this app holds, loaded on demand and then called.
 *
 * `main()` is exported and invoked here rather than run by the act of importing
 * the module. Both would behave identically today -- a top-level `await main()`
 * runs during module evaluation, and the dispatcher is awaiting that evaluation
 * either way -- so the difference is what the seam says. A call is a call: this
 * file decides when the command runs, the dispatcher holds the promise and is
 * therefore the one place that could ever decide what a rejection means, and a
 * command's module can be loaded by something that does not want to run it. A
 * module that runs on import offers none of that and reads, at the call site,
 * as an import with a side effect nobody can see from here.
 */
export interface InAppCommand {
  readonly kind: 'command';
  readonly load: () => Promise<{ readonly main: () => Promise<void> }>;
  /** One line, as `agentplex --help` lists it. */
  readonly summary: string;
}

/** A command this bin answers out of its own process. See `main.ts`. */
export interface BuiltinCommand {
  readonly kind: 'builtin';
  /** One line, as `agentplex --help` lists it. */
  readonly summary: string;
}

export const PROGRAMS: Readonly<Record<string, Program>> = {
  setup: {
    kind: 'command',
    load: () => import('./commands/setup/main.js'),
    summary: 'the wizard, or --plan <file> to replay',
  },
  doctor: {
    kind: 'command',
    load: () => import('./commands/doctor/main.js'),
    summary: 'read-only check of this machine',
  },
  help: { kind: 'builtin', summary: 'this usage, or help <command> for one command' },
};

/**
 * The two daemons, by the word somebody will type at this bin, and the unit that
 * actually runs each one.
 *
 * Every document, every unit file and every habit says `agentplex hub`, so
 * somebody is going to type it, and `unknown command "hub"` would be the one
 * answer that is both true and useless: it says the word is meaningless when the
 * word names the most important process on the machine. These two entries are
 * what turns that into a sentence with a next step in it.
 *
 * They are not in `PROGRAMS` and must not drift into it. `PROGRAMS` is the set
 * of words that do something, which is exactly what `--help` lists; a name in
 * both tables would be a command again, which is the decision this table is the
 * record of. `programs.test.ts` asserts the two stay disjoint, and that this one
 * holds exactly the daemons the package carries.
 *
 * The unit file name is the same in both scopes -- a per-user install writes
 * `~/.config/systemd/user/agentplex-hub.service`, a `--system` install writes
 * `/etc/systemd/system/agentplex-hub.service` -- so naming it is a claim this
 * can make without knowing which install it was reached from. Which `systemctl`
 * reaches it is the part that differs, and `main.ts` says so rather than
 * guessing.
 */
export const DAEMONS: Readonly<Record<string, string>> = {
  hub: 'agentplex-hub.service',
  server: 'agentplex-server.service',
};
