import { existsSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { memberRootOf } from './member-root.js';

/**
 * A package's dependency list is its allowed import set (AGX-91, AGX-301).
 *
 * Every bare specifier a file imports is reduced to the package it names and
 * looked up in the manifest of the member the file belongs to. What ships --
 * `dependencies`, `optionalDependencies`, `peerDependencies` -- may be imported
 * from any file. A devDependency is not installed beside a published package,
 * so only a test, a support module a test imports, or a test runner's
 * configuration may import one.
 *
 * The manifest is the list, rather than a list written beside it in the lint
 * configuration, so that the two cannot disagree: deleting a dependency fails
 * every file that still imports it, and declaring one is the whole of what
 * allowing it takes.
 *
 * What is judged: `import`, `export ... from`, `export * from`, and `import()`
 * with a literal specifier. A type-only declaration -- `import type`,
 * `export type` -- is erased before anything runs and names nothing an
 * installation has to find, so it passes on a devDependency. An inline
 * `import { type X }` does not: under `verbatimModuleSyntax` it still emits an
 * import of the module.
 *
 * What is not: a builtin, with or without `node:`; a relative or absolute path,
 * which is `stay-in-member`'s question; a `#` subpath import, which the member
 * resolves itself; a specifier with a scheme, which is not a package name. A
 * file with no member, or whose member is the workspace root, is skipped: the
 * root holds dev tooling and nothing that ships.
 */

/** The fields that are installed with the package, so any file may import them. */
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * A test, a support module tests import, or a test runner's configuration,
 * matched on the file's name. `test-*.ts` is the set `tsconfig.build.json`
 * keeps out of `dist/`.
 */
const TEST_FILE = [
  /\.test\.tsx?$/,
  /^test-[^/]+\.ts$/,
  /^vite\.config\.ts$/,
  /^vitest\.config\.ts$/,
];

/**
 * @typedef {{ ok: true, name: string, runtime: Set<string>, dev: Set<string> }
 *   | { ok: false, reason: string }} Manifest
 */

/**
 * @typedef {Parameters<NonNullable<import('eslint').Rule.NodeListener['ImportDeclaration']>>[0]['source']} Literal
 */

/**
 * The names in one dependency field: absent, or an object of package names to
 * range strings.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} field
 * @returns {string[] | { reason: string }}
 */
function dependencyNames(manifest, field) {
  const value = manifest[field];
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: `${field} is not an object of package names to ranges` };
  }
  const entries = Object.entries(value);
  const bad = entries.find(([, range]) => typeof range !== 'string');
  if (bad !== undefined) return { reason: `${field}.${bad[0]} is not a range string` };
  return entries.map(([name]) => name);
}

/**
 * @param {string} text The manifest's contents.
 * @param {string} root The member's directory, which names it when the manifest does not.
 * @returns {Manifest}
 */
export function parseManifest(text, root) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'it is not a JSON object' };
  }
  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (manifest.name !== undefined && typeof manifest.name !== 'string') {
    return { ok: false, reason: 'name is not a string' };
  }
  const runtime = new Set();
  for (const field of RUNTIME_FIELDS) {
    const names = dependencyNames(manifest, field);
    if (!Array.isArray(names)) return { ok: false, ...names };
    for (const name of names) runtime.add(name);
  }
  const dev = dependencyNames(manifest, 'devDependencies');
  if (!Array.isArray(dev)) return { ok: false, ...dev };
  return { ok: true, name: manifest.name ?? root, runtime, dev: new Set(dev) };
}

/** @type {Map<string, { mtimeMs: number, size: number, manifest: Manifest }>} */
const manifests = new Map();

/**
 * The member's manifest, read again only when the file has changed, so that an
 * editor's long-lived ESLint sees a dependency the moment it is declared. A
 * manifest that cannot be read or parsed is returned as the reason, and every
 * import in the file is then reported: failing open would pass the very tree
 * this rule is meant to hold.
 *
 * @param {string} root
 * @returns {Manifest}
 */
function manifestOf(root) {
  const path = join(root, 'package.json');
  try {
    const { mtimeMs, size } = statSync(path);
    const cached = manifests.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.manifest;
    }
    const manifest = parseManifest(readFileSync(path, 'utf8'), root);
    manifests.set(path, { mtimeMs, size, manifest });
    return manifest;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The package a bare specifier names: `zod/v4` is `zod`, `@scope/pkg/sub` is
 * `@scope/pkg`.
 *
 * @param {string} specifier
 * @returns {string}
 */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

/**
 * Whether a specifier names a package at all.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function namesPackage(specifier) {
  if (/^\.\.?(\/|$)/.test(specifier) || specifier.startsWith('/')) return false;
  if (specifier.startsWith('#')) return false;
  // `node:`, `data:`, `virtual:`: a package name cannot hold a colon.
  if (specifier.includes(':')) return false;
  return !isBuiltin(specifier);
}

/** @type {import('eslint').Rule.RuleModule} */
export const declaredDependency = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      undeclared:
        "'{{name}}' is not declared by {{member}}. Add it to that member's dependencies, or to its devDependencies if only tests and their configuration import it.",
      devOnly:
        "'{{name}}' is only a devDependency of {{member}}, and this file is not a test: a devDependency is not installed beside the published package. Move it to dependencies, or import only its types with `import type`.",
      unreadable:
        '{{manifest}} could not be read, so no import in this file can be checked against it: {{reason}}.',
    },
  },
  create(context) {
    const filename = context.filename;
    if (!isAbsolute(filename)) return {};
    const root = memberRootOf(dirname(filename));
    if (root === null || existsSync(join(root, 'pnpm-workspace.yaml'))) return {};
    const manifest = manifestOf(root);
    const isTest = TEST_FILE.some((pattern) => pattern.test(basename(filename)));

    /** @param {Literal} source */
    const check = (source) => {
      const specifier = source.value;
      if (typeof specifier !== 'string' || !namesPackage(specifier)) return;
      if (!manifest.ok) {
        context.report({
          node: source,
          messageId: 'unreadable',
          data: { manifest: join(root, 'package.json'), reason: manifest.reason },
        });
        return;
      }
      const name = packageNameOf(specifier);
      if (manifest.runtime.has(name) || (isTest && manifest.dev.has(name))) return;
      context.report({
        node: source,
        messageId: manifest.dev.has(name) ? 'devOnly' : 'undeclared',
        data: { name, member: manifest.name },
      });
    };

    return {
      ImportDeclaration(node) {
        if ('importKind' in node && node.importKind === 'type') return;
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined) return;
        if ('exportKind' in node && node.exportKind === 'type') return;
        check(node.source);
      },
      ExportAllDeclaration(node) {
        if ('exportKind' in node && node.exportKind === 'type') return;
        check(node.source);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node.source);
      },
    };
  },
};
