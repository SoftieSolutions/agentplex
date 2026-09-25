import { directorySchema } from '@agentplex/protocol';

/**
 * A directory an operation will accept, which is now the same schema a frame
 * carrying one is parsed by.
 *
 * It used to be defined here, on the argument that the operations taking a
 * directory must agree about what one is: two copies are two things to keep in
 * step, and the day they disagree one operation accepts a path the other
 * refuses, which reads as a bug in git. AGX-238 widened the set that has to
 * agree rather than weakening the argument. A directory now crosses the wire,
 * so the schema a frame is parsed by and the schema an operation's request is
 * parsed by have to be one schema, and the only package both ends may name is
 * `protocol`. It is re-exported from here so that nothing in this directory
 * changed its import, and so that the reason sits where somebody adding an
 * operation will read it.
 *
 * One thing did change in the move, and it is worth knowing: absolute now means
 * a leading `/` rather than whatever `node:path` says, because the schema is
 * bundled into a browser as well. `packages/protocol/src/directory.ts` argues
 * that, and on every machine agentplex runs a server on the two answer the same.
 *
 * Note what it still does *not* do: it does not decide whether the directory is
 * one a caller may look at. That is `parseWorkingDirectory`'s job where a
 * session's directory is chosen and `directory-browse.ts`'s where a listing is
 * asked for, and duplicating either here would put the same policy in two
 * places to drift apart.
 */
export { directorySchema };
