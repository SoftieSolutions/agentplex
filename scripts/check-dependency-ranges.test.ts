import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRAMMAR,
  checkWorkspace,
  manifestOffences,
  offenceLine,
  parseWorkspaceGlobs,
  report,
  wantedFor,
  workspaceManifests,
  type Offence,
} from './check-dependency-ranges.js';

/** The checkout this suite is running inside: the fixture is the tree itself. */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A workspace of our own shape -- a `pnpm-workspace.yaml` with member globs and
 * manifests under them -- written somewhere a test may write. The synthetic
 * half of the suite: the real tree cannot hold a failing manifest, and a check
 * nobody has watched fail is a check nobody has tested.
 */
async function syntheticWorkspace(
  manifests: Readonly<Record<string, unknown>>,
  globs = '  - pkg/*\n',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentplex-ranges-'));
  temporary.push(root);
  await writeFile(join(root, 'pnpm-workspace.yaml'), `packages:\n${globs}`);
  for (const [path, manifest] of Object.entries(manifests)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  return root;
}

describe('the three forms', () => {
  it.each([
    'workspace:*',
    '1.1.0',
    '0.11.0',
    '30.0.1',
    '1.2.3-rc.1',
    '>=4.5.4 <5.0.0',
    '>=24.13.3 <25.0.0',
    '>=1.0.0 <2.0.0',
  ])('takes %s', (value) => {
    expect(
      manifestOffences('package.json', JSON.stringify({ dependencies: { a: value } })),
    ).toEqual([]);
  });

  it.each([
    // A caret at or above 1.0 is the default `pnpm add` writes, and the window
    // it stands for is what the check names back.
    ['^4.1.13', '>=4.1.13 <5.0.0'],
    ['~5.1.0', '>=5.1.0 <6.0.0'],
    // Below 1.0 the same character means a different bound, which is the whole
    // argument for writing it out. The policy takes an exact pin there.
    ['^0.11.0', '0.11.0'],
    ['>=0.11.0 <0.12.0', '0.11.0'],
    // A floor with nothing above it: the offence the ticket is named for.
    ['>=8.21.3', '>=8.21.3 <9.0.0'],
    // An upper bound that is not a major boundary is still not the one form.
    ['>=1.2.3 <1.5.0', '>=1.2.3 <2.0.0'],
    ['>=1.2.3 <2.1.0', '>=1.2.3 <2.0.0'],
    ['>=1.2.3 <2.0.1', '>=1.2.3 <2.0.0'],
    // A window reaching past the next major. It satisfies every shape the
    // grammar used to name -- a floor, one space, a ceiling at a major boundary
    // above 1 -- and it is the case the policy was rewritten to refuse: two
    // majors is a different rule, so widening one is an edit to CONTRIBUTING
    // rather than a range that passes the lint on its way through.
    ['>=4.1.13 <9.0.0', '>=4.1.13 <5.0.0'],
    ['>=0.11.0 <2.0.0', '0.11.0'],
    // The window form starts at a floor of 1.0. Below that the ceiling a major
    // above the floor is the one that promises nothing -- semver puts the break
    // in the minor there, so `>=0.11.0 <1.0.0` spans every break between 0.11
    // and 1.0 while wearing the shape of the form that spans none. Exact is the
    // only compliant form below 1.0, and it is what the check names.
    ['>=0.11.0 <1.0.0', '0.11.0'],
    ['>=0.0.1 <1.0.0', '0.0.1'],
    // `>=` and `<` are the only comparators the form takes, which the policy
    // names these two as the near misses of. Both are shaped like a window and
    // neither says what one says.
    ['>4.1.12 <5.0.0', '>=4.1.12 <5.0.0'],
    ['>=4.1.13 <=5.0.0', '>=4.1.13 <5.0.0'],
    // Two spaces between the comparators: one grammar, written one way.
    ['>=1.2.3  <2.0.0', '>=1.2.3 <2.0.0'],
    ['>= 1.2.3 <2.0.0', '>=1.2.3 <2.0.0'],
    // Nothing to derive a bound from, so the check names the grammar instead.
    ['*', GRAMMAR],
    ['latest', GRAMMAR],
    ['1.2', GRAMMAR],
    ['>=18', GRAMMAR],
    ['github:softiesolutions/agentplex', GRAMMAR],
    ['workspace:^', GRAMMAR],
  ])('refuses %s and wants %s', (value, wanted) => {
    expect(wantedFor(value)).toBe(wanted);
    expect(
      manifestOffences('apps/hub/package.json', JSON.stringify({ dependencies: { a: value } })),
    ).toEqual([
      {
        manifest: 'apps/hub/package.json',
        field: 'dependencies',
        dependency: 'a',
        value,
        wanted,
      },
    ] satisfies Offence[]);
  });

  it('reads all four dependency fields and no other', () => {
    const text = JSON.stringify({
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '^1.0.0' },
      optionalDependencies: { c: '^1.0.0' },
      peerDependencies: { d: '^1.0.0' },
      engines: { node: '>=24', pnpm: '>=11' },
      packageManager: 'pnpm@11.17.0',
      pnpm: { overrides: { e: '^1.0.0' } },
      resolutions: { f: '^1.0.0' },
    });
    expect(manifestOffences('package.json', text).map((offence) => offence.dependency)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('names the manifest, the dependency and the bound it wanted, on one line', () => {
    expect(
      offenceLine({
        manifest: 'apps/web/package.json',
        field: 'devDependencies',
        dependency: 'vite',
        value: '^7.3.6',
        wanted: '>=7.3.6 <8.0.0',
      }),
    ).toBe('apps/web/package.json: devDependencies.vite is ^7.3.6, wanted >=7.3.6 <8.0.0');
  });

  it('refuses a manifest whose dependency value is not a string', () => {
    expect(() =>
      manifestOffences('package.json', JSON.stringify({ dependencies: { a: 1 } })),
    ).toThrow(/package\.json/);
  });

  it('names the manifest when it is not JSON at all', () => {
    // A SyntaxError names a position and not a file, and this walks twelve of
    // them, so the bare message sends a reader looking through all twelve.
    expect(() => manifestOffences('apps/web/package.json', '{ "dependencies": }')).toThrow(
      /apps\/web\/package\.json is not JSON/,
    );
  });
});

describe('the workspace it reads', () => {
  it('takes the member globs from pnpm-workspace.yaml rather than a hardcoded list', async () => {
    const text = await readFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', text)).toEqual([
      'apps/*',
      'packages/*',
      'scripts',
      'tests/*',
    ]);
  });

  it('stops the list at the next key rather than reading further items out of the file', () => {
    const text = 'packages:\n  - a/*\n  # a comment\n  - b\n\nallowBuilds:\n  - not-a-member\n';
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', text)).toEqual(['a/*', 'b']);
  });

  it('takes an item with a comment after it, and the glob stops at the comment', () => {
    // Valid YAML, and pnpm reads the glob as `packages/*`. Taking the comment as
    // part of it would match no directory, skip five manifests, and print a
    // smaller count than the run before it with nothing to say why.
    const text = 'packages:\n  - apps/* # the deployables\n  - packages/*\t# the seams\n';
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', text)).toEqual(['apps/*', 'packages/*']);
  });

  it('takes a quoted item, with or without a comment after it', () => {
    const text = 'packages:\n  - \'apps/*\'\n  - "packages/*" # the seams\n';
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', text)).toEqual(['apps/*', 'packages/*']);
  });

  it('keeps a # that opens no comment, because a space is what opens one', () => {
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', 'packages:\n  - apps/a#b\n')).toEqual([
      'apps/a#b',
    ]);
  });

  it('takes a sequence at column 0, which pnpm takes too', () => {
    expect(parseWorkspaceGlobs('pnpm-workspace.yaml', 'packages:\n- apps/*\n- scripts\n')).toEqual([
      'apps/*',
      'scripts',
    ]);
  });

  it('refuses an item it cannot read rather than guessing at a glob', () => {
    // Whitespace left after the comment strip means this did not understand the
    // line. Reading a subset of YAML is fine; reading fewer manifests than it
    // claims to is not, so the refusal names the line.
    expect(() =>
      parseWorkspaceGlobs('pnpm-workspace.yaml', 'packages:\n  - apps/* extra\n'),
    ).toThrow(/pnpm-workspace\.yaml has a member this cannot read: - apps\/\* extra/);
    expect(() => parseWorkspaceGlobs('pnpm-workspace.yaml', 'packages:\n  - "a b"\n')).toThrow(
      /cannot read/,
    );
  });

  it('refuses a workspace file that declares no members', () => {
    expect(() =>
      parseWorkspaceGlobs('pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: true\n'),
    ).toThrow(/pnpm-workspace\.yaml/);
  });

  it('finds the root manifest and every member that has one', async () => {
    // `git ls-files '*package.json'` verbatim. Written out rather than asserted
    // loosely because the failure this guards against is a quiet one: a member
    // glob this stopped understanding would drop manifests and still report a
    // clean workspace, and a count nobody knows the right value of is not
    // evidence. A new package is a line here, which is the cheap half.
    expect(await workspaceManifests(workspaceRoot)).toEqual([
      'apps/cli/package.json',
      'apps/hub/package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'package.json',
      'packages/node-shared/package.json',
      'packages/protocol/package.json',
      'packages/providers/package.json',
      'packages/pty/package.json',
      'packages/release/package.json',
      'scripts/package.json',
      'tests/hub-server/package.json',
    ]);
    // The tracked set and nothing else: `git ls-files '*package.json'` returns
    // these twelve, and the directories `.gitignore` covers are absent because
    // none of them is a workspace member.
  });

  it('reads no manifest git does not track, assembled output included', async () => {
    const root = await syntheticWorkspace({
      'package.json': {},
      'pkg/a/package.json': {},
      // What `pnpm package` leaves behind. `.gitignore` covers both, and the
      // ranges in them are the assembler's output rather than anybody's
      // decision, so the policy does not govern them.
      'pkg/a/dist/package.json': { dependencies: { zod: '^4.5.4' } },
      'pkg/a/release/package.json': { dependencies: { zod: '^4.5.4' } },
      'pkg/a/node_modules/zod/package.json': { dependencies: { a: '^1.0.0' } },
    });
    expect(await workspaceManifests(root)).toEqual(['package.json', 'pkg/a/package.json']);
    expect(await checkWorkspace(root)).toEqual([]);
  });

  it('skips a member directory that has no manifest of its own', async () => {
    const root = await syntheticWorkspace({ 'package.json': {}, 'pkg/a/package.json': {} });
    await mkdir(join(root, 'pkg', 'b'), { recursive: true });
    expect(await workspaceManifests(root)).toEqual(['package.json', 'pkg/a/package.json']);
  });
});

describe('this workspace', () => {
  it('holds no dependency range with no upper bound', async () => {
    expect(await checkWorkspace(workspaceRoot)).toEqual([]);
  });

  it('reports one line and a zero exit for a tree that is already bounded', async () => {
    const { ok, lines } = await report(workspaceRoot);
    expect(ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+ manifests checked/);
  });

  // The real root manifest with one value put back the way `pnpm add -D` would
  // have written it. The fixture is the tree, so the check is watched failing
  // on the exact text it passes on everywhere else.
  it('fails the root manifest the moment a caret is written back into it', async () => {
    const text = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
    const reverted = text.replace('">=9.39.5 <10.0.0"', '"^9.39.5"');
    expect(reverted).not.toBe(text);

    expect(manifestOffences('package.json', reverted)).toEqual([
      {
        manifest: 'package.json',
        field: 'devDependencies',
        dependency: '@eslint/js',
        value: '^9.39.5',
        wanted: '>=9.39.5 <10.0.0',
      },
    ] satisfies Offence[]);
  });
});

describe('a workspace that has drifted', () => {
  it('names every offence once, manifest by manifest, and exits 1', async () => {
    const root = await syntheticWorkspace({
      'package.json': { devDependencies: { prettier: '^3.9.6', typescript: '>=5.9.3 <6.0.0' } },
      'pkg/a/package.json': {
        dependencies: { '@agentplex/b': 'workspace:*', ws: '>=8.21.3' },
        optionalDependencies: { 'node-pty': '^1.1.0' },
      },
      'pkg/b/package.json': { dependencies: { zod: '>=4.5.4 <5.0.0' } },
    });

    const { ok, lines } = await report(root);
    expect(ok).toBe(false);
    expect(lines.slice(0, 3)).toEqual([
      'package.json: devDependencies.prettier is ^3.9.6, wanted >=3.9.6 <4.0.0',
      'pkg/a/package.json: dependencies.ws is >=8.21.3, wanted >=8.21.3 <9.0.0',
      'pkg/a/package.json: optionalDependencies.node-pty is ^1.1.0, wanted >=1.1.0 <2.0.0',
    ]);
    expect(lines[3]).toContain('CONTRIBUTING.md');
    expect(lines).toHaveLength(4);
  });
});
