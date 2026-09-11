/**
 * What the `agentplex` bin answers to, by name.
 *
 * Three kinds, and the kinds are an architectural boundary written down rather
 * than a dispatch convenience.
 *
 * A **dispatched** program is another app's build artifact, reached by path and
 * never by import. Nothing imports an app, so `entry` is a URL and not a
 * specifier, and TypeScript is deliberately told nothing about what is at the
 * far end of it: the two daemons are separate programs that compose in the
 * package, where their `dist/` directories sit next to one another, and a
 * checked import would make them one program in four files. The paths are the
 * workspace's, so they are correct from a checkout, in the image and in the
 * published tarball alike. They are relative to this directory, which is the
 * one `main.js` is emitted into too.
 *
 * An **in-app command** is ordinary code in this app, reached by a real import
 * that the compiler checks like any other. `setup` and `doctor` live under
 * `src/commands/`, so there is no boundary to cross and nothing to be careful
 * about: renaming an export breaks the build here, where a dispatched entry
 * would have broken at runtime on somebody's machine. What it buys over
 * flattening the whole table into imports is nothing -- it costs, in that this
 * app now carries what those two commands need -- and what it buys over leaving
 * them as separate apps is that the two things that were only ever reached
 * through this bin stop pretending to be deployables.
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
 * It is its own module so that a test can read it: `main.ts` dispatches at
 * module top level, and importing that file is running the bin. The list of
 * dispatched names exists a second time in `scripts/assemble-package.ts`,
 * deciding whose `dist/` travels in the tarball; `programs.test.ts` is what
 * keeps the two from drifting apart, and `kind` is what tells it which names
 * are that list's business.
 */
export type Program = DispatchedProgram | InAppCommand | BuiltinCommand;

/** A separate program, reached by path once the command word is consumed. */
export interface DispatchedProgram {
  readonly kind: 'dispatched';
  /** The program's built entry, relative to this file. */
  readonly entry: string;
  /** One line, as `agentplex --help` lists it. */
  readonly summary: string;
}

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
  hub: { kind: 'dispatched', entry: '../../hub/dist/main.js', summary: 'the hub daemon' },
  server: { kind: 'dispatched', entry: '../../server/dist/main.js', summary: 'the server daemon' },
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
