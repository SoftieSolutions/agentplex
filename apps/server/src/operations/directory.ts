import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * A directory an operation will accept.
 *
 * Absolute, because a relative path would resolve against whatever directory
 * agentplex happens to have been started in — and because an absolute path
 * cannot be mistaken by git for one of its own options. No NUL, because a NUL
 * truncates the path at the syscall, so what is opened is a prefix of what was
 * checked.
 *
 * Note what this does *not* do: it does not decide whether the directory is one
 * a session may look at. That is `parseWorkingDirectory`'s job at the point a
 * session's directory is chosen, and duplicating it here would put the same
 * policy in two places to drift apart.
 *
 * It is one module rather than one per operation because the operations that
 * take a directory must agree about what one is. Two copies of this schema are
 * two things to keep in step, and the day they disagree one operation accepts a
 * path the other refuses — which reads as a bug in git.
 */
export const directorySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'a directory may not contain a null byte')
  .refine(isAbsolute, 'a directory must be an absolute path');

/**
 * The first line of a program's stderr, for a refusal that quotes it.
 *
 * git says why better than anything here could — "not a git repository",
 * "detected dubious ownership", "bad revision 'HEAD'" — and the first line is
 * the sentence; whatever follows is usage text nobody asked for.
 */
export function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line === undefined || line === '' ? 'it said nothing' : line;
}
