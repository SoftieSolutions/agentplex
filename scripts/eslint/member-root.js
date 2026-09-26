import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @type {Map<string, string | null>} */
const memberRoots = new Map();

/**
 * The member a path belongs to: the nearest directory at or above it holding a
 * `package.json`, or null when there is none up to the filesystem root.
 *
 * A member is each app, each package, `scripts`, each suite under `tests`, and
 * the repository root around them. Two rules ask this question -- where a
 * relative import lands, and whose manifest a bare one is judged by -- so the
 * walk lives here once. The answer is cached for the life of the process, as a
 * new member is a new directory and not an edit.
 *
 * @param {string} path An absolute path.
 * @returns {string | null}
 */
export function memberRootOf(path) {
  const known = memberRoots.get(path);
  if (known !== undefined) return known;
  const parent = dirname(path);
  const root = existsSync(join(path, 'package.json'))
    ? path
    : parent === path
      ? null
      : memberRootOf(parent);
  memberRoots.set(path, root);
  return root;
}
