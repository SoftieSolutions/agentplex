import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The doctor opens no pty, checked over the whole program rather than over one
 * directory of it (AGX-215).
 *
 * `eslint.config.js` has a `doctorOpensNoPty` block, and it reads as though it
 * enforces a property of the doctor. It enforces a property of the doctor's own
 * files: it is scoped to `apps/cli/src/commands/doctor/**`, so it sees a
 * specifier written in this directory and nothing else. `apps/cli` as a whole
 * declares `@agentplex/pty` -- legitimately, because the wizard beside this
 * directory opens terminals -- so a module anywhere else in the app could bind
 * `createPtySupervisor`, this directory could import that module, and every
 * lint rule in the repository would pass. That was measured, not reasoned: a
 * two-line `apps/cli/src/leak-probe.ts` imported from `main.ts` here linted
 * clean at exit 0.
 *
 * A half-enforced constraint is worse than a documented one, because the second
 * gets read and the first gets trusted. So the line is drawn here, where it can
 * be drawn at all: start at the entrypoint, follow every import out of it
 * through the workspace, and look at what each module reached binds from
 * `@agentplex/pty`.
 *
 * **Why a test and not a lint rule.** ESLint sees one file at a time. That is
 * not a gap in the configuration, it is the shape of the tool, and the obvious
 * candidate for closing it does not:
 * `eslint-plugin-import`'s `no-restricted-paths` was run against a three-module
 * chain -- a file in the target zone importing a sibling that imports the
 * forbidden zone -- and it reported only the direct import. Its zones are
 * resolved per import declaration in the file being linted; there is no
 * traversal and no option asking for one. It would restate today's rule in a
 * different vocabulary and catch exactly what today's rule catches.
 *
 * Splitting the doctor into a package of its own would work -- the package
 * boundary demonstrably does enforce this, which is why adding the same import
 * to `packages/providers` fails lint -- and it would reverse AGX-192, which
 * folded setup and doctor into the one bin deliberately. That decision is worth
 * reopening on its own merits and is not worth reversing as a side effect of
 * tightening a lint rule.
 *
 * **What this asserts, exactly.** Not that `@agentplex/pty` is absent from the
 * graph: the doctor imports `checkNodePty` from it on purpose, because node-pty
 * is an optional dependency of the published package and a doctor that could
 * not ask whether it loads would report a server ready right up to the first
 * session that would not start. The property is the one `doctorOpensNoPty`
 * states in words -- of everything the doctor can reach, the only names bound
 * from that package are the three that ask a question and cannot answer it by
 * opening anything. Same list, same verdict, followed all the way out.
 *
 * The lint rule stays. It fails in the editor on the import a contributor is
 * actually most likely to write, and it says why at the line where they wrote
 * it. This is the backstop under it, and the two agree by sharing `ALLOWED`
 * with that block by hand -- the config is a `.js` file loaded by ESLint, and
 * an app's suite importing the repository's lint configuration would be a worse
 * coupling than two lists that a failure here names in full.
 */

/** The repository root: five directories above this file. */
const REPOSITORY = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The doctor, as the bin's dispatcher loads it. */
const ENTRYPOINT = fileURLToPath(new URL('./main.ts', import.meta.url));

/** The package the doctor may ask a question of and may not use. */
const PTY = '@agentplex/pty';

/**
 * The three names `eslint.config.js` permits, and the argument for each is
 * there. `checkNodePty` loads the addon and answers; the other two are the
 * remedy string it prints and the shape of its answer.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  'checkNodePty',
  'NODE_PTY_REMEDY',
  'PtyAvailability',
]);

/** Workspace specifiers, as opposed to `zod`, `ws` or `node:fs`. */
const WORKSPACE_SCOPES = ['@agentplex/', '@softiesolutions/'];

/**
 * What one import statement binds: the names it names, or `everything` for a
 * namespace import, a default binding, an `export *` or a dynamic `import()`,
 * none of which can be narrowed to a list.
 */
type Bound = readonly string[] | 'everything';

interface Binding {
  readonly specifier: string;
  readonly bound: Bound;
}

/** A module reached by the walk, and what it binds from where. */
interface PtyBinding extends Binding {
  /** Repository-relative, because that is what a failure has to be readable as. */
  readonly module: string;
}

interface Walk {
  /** Every first-party module reachable from the entrypoint, repository-relative. */
  readonly modules: readonly string[];
  readonly ptyBindings: readonly PtyBinding[];
  /** First-party specifiers this walk could not turn into a file. */
  readonly unresolved: readonly string[];
  /** `import(expression)`: a specifier no reader can follow. */
  readonly opaque: readonly string[];
}

function relative(file: string): string {
  return path.relative(REPOSITORY, file);
}

/** A manifest read off disk is a claim: narrowed, never cast. */
function manifestName(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)) return undefined;
  return typeof manifest.name === 'string' ? manifest.name : undefined;
}

/**
 * A manifest's `exports` as subpath -> target, keeping only the entries shaped
 * the way every package in this workspace writes them. An entry shaped some
 * other way is not registered, so a specifier reaching it lands in
 * `unresolved` and fails loudly rather than being walked past.
 */
function exportTargets(manifest: unknown): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  if (typeof manifest !== 'object' || manifest === null || !('exports' in manifest)) return targets;
  const exports: unknown = manifest.exports;
  if (typeof exports !== 'object' || exports === null) return targets;
  for (const [subpath, entry] of Object.entries(exports)) {
    if (typeof entry !== 'object' || entry === null || !('default' in entry)) continue;
    const target: unknown = entry.default;
    if (typeof target === 'string') targets.set(subpath, target);
  }
  return targets;
}

/**
 * Every workspace specifier, mapped to the TypeScript file behind it.
 *
 * Derived from each member's own manifest rather than from a table written
 * here, so a package added or an entry point renamed tomorrow is followed
 * without an edit -- this has to guard the property and not today's layout.
 * The published entry is `./dist/index.js` and the source beside it is
 * `src/index.ts`; that one rewrite is the whole of the mapping, and a target
 * not shaped like it is left out deliberately.
 */
function workspaceEntryPoints(): ReadonlyMap<string, string> {
  const entryPoints = new Map<string, string>();
  for (const group of ['apps', 'packages']) {
    const groupDirectory = path.join(REPOSITORY, group);
    if (!existsSync(groupDirectory)) continue;
    for (const member of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!member.isDirectory()) continue;
      const directory = path.join(groupDirectory, member.name);
      const manifestPath = path.join(directory, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const name = manifestName(manifest);
      if (name === undefined) continue;
      for (const [subpath, target] of exportTargets(manifest)) {
        const built = /^\.\/dist\/(.+)\.js$/.exec(target);
        if (built === null) continue;
        const specifier = subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`;
        entryPoints.set(specifier, path.join(directory, 'src', `${built[1]}.ts`));
      }
    }
  }
  return entryPoints;
}

const ENTRY_POINTS = workspaceEntryPoints();

function importedNames(clause: ts.ImportClause | undefined): Bound {
  // `import './side-effect.js'`: binds nothing at all.
  if (clause === undefined) return [];
  // A default binding, alone or beside named ones. There is no default export
  // anywhere in this workspace, so this is a mistake rather than a hole -- but
  // the conservative reading is the right one to encode either way.
  if (clause.name !== undefined) return 'everything';
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return 'everything';
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

function reExportedNames(clause: ts.NamedExportBindings | undefined): Bound {
  // `export * from` and `export * as ns from`: everything the module has.
  if (clause === undefined || ts.isNamespaceExport(clause)) return 'everything';
  return clause.elements.map((element) => (element.propertyName ?? element.name).text);
}

/**
 * Every specifier one file names, with what it binds from each.
 *
 * A re-export counts: `export { createPtySupervisor } from '@agentplex/pty'` in
 * a module the doctor imports hands the doctor the same expression an import
 * would. So does a dynamic `import()`, which yields the whole module object.
 */
function bindingsOf(file: string): {
  readonly bindings: readonly Binding[];
  readonly opaque: number;
} {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const bindings: Binding[] = [];
  let opaque = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      bindings.push({
        specifier: node.moduleSpecifier.text,
        bound: importedNames(node.importClause),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      bindings.push({
        specifier: node.moduleSpecifier.text,
        bound: reExportedNames(node.exportClause),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [target] = node.arguments;
      if (target !== undefined && ts.isStringLiteral(target)) {
        bindings.push({ specifier: target.text, bound: 'everything' });
      } else {
        opaque += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return { bindings, opaque };
}

/**
 * The file a specifier names, or `undefined` when it names something outside
 * this repository. `@agentplex/pty` is resolved by the caller instead: it is
 * the boundary, so what matters about it is what was bound, not what is behind
 * it.
 */
function resolve(specifier: string, from: string): string | undefined {
  if (specifier.startsWith('.')) {
    // Built output is what ships, so every relative specifier in this
    // repository is written `./x.js` and the file beside it is `./x.ts`.
    const emitted = /^(.*)\.js$/.exec(specifier);
    if (emitted === null) return undefined;
    return path.resolve(path.dirname(from), `${emitted[1]}.ts`);
  }
  return ENTRY_POINTS.get(specifier);
}

function isWorkspace(specifier: string): boolean {
  return WORKSPACE_SCOPES.some((scope) => specifier.startsWith(scope));
}

/** Breadth-first out of the entrypoint, through every module this repository owns. */
function walkFrom(entrypoint: string): Walk {
  const seen = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  const ptyBindings: PtyBinding[] = [];
  const unresolved: string[] = [];
  const opaque: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) continue;
    const module = relative(file);
    const read = bindingsOf(file);
    for (let count = 0; count < read.opaque; count += 1) opaque.push(module);

    for (const binding of read.bindings) {
      const { specifier } = binding;
      if (specifier === PTY || specifier.startsWith(`${PTY}/`)) {
        ptyBindings.push({ ...binding, module });
        continue;
      }
      const resolved = resolve(specifier, file);
      if (resolved === undefined) {
        // A relative specifier or a workspace one that this walk could not turn
        // into a file is a hole in the walk, not a module without imports. Said
        // out loud; everything else -- `node:fs`, `zod`, `ws` -- is not ours.
        if (specifier.startsWith('.') || isWorkspace(specifier)) {
          unresolved.push(`${module} -> ${specifier}`);
        }
        continue;
      }
      if (!existsSync(resolved)) {
        unresolved.push(`${module} -> ${specifier}`);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }

  return { modules: [...seen].map(relative).sort(), ptyBindings, unresolved, opaque };
}

const DOCTOR = walkFrom(ENTRYPOINT);

/** Every binding the doctor's graph takes from the pty package that is not one of the three. */
function forbiddenBindings(): readonly string[] {
  return DOCTOR.ptyBindings.flatMap(({ module, specifier, bound }) => {
    // A subpath reaches past the package's own entry point, so there is no
    // question of which names it took: the whole of it is off limits.
    if (specifier !== PTY) return [`${module} imports ${specifier}`];
    if (bound === 'everything') return [`${module} binds all of ${specifier}`];
    return bound.filter((name) => !ALLOWED.has(name)).map((name) => `${module} binds ${name}`);
  });
}

describe('everything the doctor can reach', () => {
  it('binds nothing from the pty package but the three names that only ask a question', () => {
    expect(forbiddenBindings()).toEqual([]);
  });

  it('is walked to the end, so a clean result is a result and not a short walk', () => {
    expect(DOCTOR.unresolved).toEqual([]);
    expect(DOCTOR.opaque).toEqual([]);
  });

  it('crosses the package lines the doctor actually depends on', () => {
    // The assertion above is worth what this one is: a walk that quietly
    // resolved nothing outside this directory would report no forbidden
    // binding and mean nothing by it. These are the crossings that make the
    // check a check -- out of the app, into the seams the doctor composes.
    expect(DOCTOR.modules).toEqual(
      expect.arrayContaining([
        path.join('apps', 'cli', 'src', 'commands', 'doctor', 'doctor.ts'),
        path.join('packages', 'node-shared', 'src', 'index.ts'),
        path.join('packages', 'providers', 'src', 'index.ts'),
      ]),
    );
  });

  it('does ask whether a pty can be opened, which is the whole reason for the exception', () => {
    const asked = DOCTOR.ptyBindings.flatMap(({ bound }) => (bound === 'everything' ? [] : bound));
    expect(asked).toContain('checkNodePty');
  });
});
