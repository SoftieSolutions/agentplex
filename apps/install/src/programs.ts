/**
 * What the `agentplex` bin dispatches to, by name.
 *
 * By path, never by import. Each program's built entry is loaded from where the
 * assembled tree puts it, the same distance `apps/hub` is from `apps/web/dist`,
 * so the rule that no app imports another holds in source and composition
 * happens where it belongs: in the package, where five `dist/` directories sit
 * next to one another. The paths are the workspace's, so they are correct from
 * a checkout, in the image and in the published tarball alike. They are
 * relative to this directory, which is the one `main.js` is emitted into too.
 *
 * It is its own module so that a test can read it: `main.ts` dispatches at
 * module top level, and importing that file is running the bin. The same list
 * of names exists a second time in `packaging/assemble-package.ts`, deciding
 * whose `dist/` travels in the tarball; `programs.test.ts` is what keeps the
 * two from drifting apart.
 */
export interface Program {
  /** The program's built entry, relative to this file. */
  readonly entry: string;
  /** One line, as `agentplex --help` lists it. */
  readonly summary: string;
}

export const PROGRAMS: Readonly<Record<string, Program>> = {
  hub: { entry: '../../hub/dist/main.js', summary: 'the hub daemon' },
  server: { entry: '../../server/dist/main.js', summary: 'the server daemon' },
  setup: { entry: '../../setup/dist/main.js', summary: 'the wizard, or --plan <file> to replay' },
  doctor: { entry: '../../doctor/dist/main.js', summary: 'read-only check of this machine' },
};
