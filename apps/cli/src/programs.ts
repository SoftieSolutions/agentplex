/**
 * What the `agentplex` bin answers to, by name.
 *
 * Four of the five are dispatched by path, never by import. Each program's
 * built entry is loaded from where the assembled tree puts it, the same
 * distance `apps/hub` is from `apps/web/dist`, so the rule that no app imports
 * another holds in source and composition happens where it belongs: in the
 * package, where five `dist/` directories sit next to one another. The paths
 * are the workspace's, so they are correct from a checkout, in the image and in
 * the published tarball alike. They are relative to this directory, which is
 * the one `main.js` is emitted into too.
 *
 * The fifth is `help`, which has no program behind it: the bin answers it
 * itself, out of this same table. It is in the table rather than beside it so
 * that `agentplex --help` lists it, and a command nothing lists is a command
 * nobody finds.
 *
 * It is its own module so that a test can read it: `main.ts` dispatches at
 * module top level, and importing that file is running the bin. The list of
 * dispatched names exists a second time in `scripts/assemble-package.ts`,
 * deciding whose `dist/` travels in the tarball; `programs.test.ts` is what
 * keeps the two from drifting apart, and `kind` is what tells it which names
 * are that list's business.
 */
export type Program = DispatchedProgram | BuiltinCommand;

/** A separate program, reached by path once the command word is consumed. */
export interface DispatchedProgram {
  readonly kind: 'dispatched';
  /** The program's built entry, relative to this file. */
  readonly entry: string;
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
    kind: 'dispatched',
    entry: '../../setup/dist/main.js',
    summary: 'the wizard, or --plan <file> to replay',
  },
  doctor: {
    kind: 'dispatched',
    entry: '../../doctor/dist/main.js',
    summary: 'read-only check of this machine',
  },
  help: { kind: 'builtin', summary: 'this usage, or help <command> for one command' },
};
