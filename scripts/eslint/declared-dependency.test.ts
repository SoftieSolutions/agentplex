import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { declaredDependency } from './declared-dependency.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/**
 * A workspace of our own shape, named here so the cases below can carry
 * absolute filenames inside it, and written in `beforeAll`. RuleTester builds
 * its cases when `run` is called, which is while this file is collected, so the
 * directory has to exist by name before any hook has run.
 *
 * Each manifest the suite needs sits in a member of its own rather than being
 * rewritten between cases: the rule reads a manifest once per content, and a
 * suite that edited one in place would be testing the cache as much as the
 * rule.
 */
const tree = mkdtempSync(join(tmpdir(), 'agentplex-declared-dependency-'));

const MEMBER = '@fixture/member';

const files: Readonly<Record<string, string>> = {
  'pnpm-workspace.yaml': 'packages:\n  - member\n  - broken\n  - misshapen\n',
  'package.json': JSON.stringify({ name: 'fixture-root', private: true }),
  'member/package.json': JSON.stringify({
    name: MEMBER,
    dependencies: { zod: '>=4.5.4 <5.0.0', '@scope/pkg': '1.0.0' },
    devDependencies: { vitest: '>=3.2.7 <4.0.0', ws: '>=8.21.3 <9.0.0' },
    optionalDependencies: { 'node-pty': '1.1.0' },
    peerDependencies: { react: '>=19.0.0 <20.0.0' },
  }),
  'broken/package.json': '{ "name": "@fixture/broken", ',
  'misshapen/package.json': JSON.stringify({ name: '@fixture/misshapen', dependencies: ['zod'] }),
};

beforeAll(() => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), content);
  }
});

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

const source = join(tree, 'member/src/a.ts');
const testFiles = [
  join(tree, 'member/src/a.test.ts'),
  join(tree, 'member/src/a.integration.test.ts'),
  join(tree, 'member/src/a.test.tsx'),
  join(tree, 'member/src/test-home.ts'),
  join(tree, 'member/vitest.config.ts'),
  join(tree, 'member/vite.config.ts'),
];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('declared-dependency', declaredDependency, {
  valid: [
    { filename: source, code: "import 'zod';" },
    { filename: source, code: "import { z } from 'zod/v4';" },
    { filename: source, code: "import { spawn } from 'node-pty';" },
    { filename: source, code: "import { useState } from 'react';" },
    { filename: source, code: "import { thing } from '@scope/pkg/sub';" },
    { filename: source, code: "export { thing } from '@scope/pkg';" },
    { filename: source, code: "const zod = await import('zod');" },
    ...testFiles.flatMap((filename) => [
      { filename, code: "import { it } from 'vitest';" },
      { filename, code: "import { WebSocket } from 'ws';" },
      { filename, code: "import 'zod';" },
    ]),
    // A type-only import is erased before anything runs: it names no module
    // the installed package has to be able to find.
    { filename: source, code: "import type { WebSocket } from 'ws';" },
    { filename: source, code: "export type { WebSocket } from 'ws';" },
    { filename: source, code: "export type * from 'ws';" },
    { filename: source, code: "import { readFile } from 'node:fs/promises';" },
    { filename: source, code: "import { readFile } from 'fs/promises';" },
    { filename: source, code: "import { b } from './b.js';" },
    { filename: source, code: "import { c } from '../c.js';" },
    { filename: source, code: "import { d } from '#internal/d';" },
    { filename: source, code: 'const name = "ws"; await import(name);' },
    // The workspace root holds dev tooling and nothing that ships.
    { filename: join(tree, 'eslint.config.js'), code: "import 'lodash';" },
  ],
  invalid: [
    {
      filename: source,
      code: "import { WebSocket } from 'ws';",
      errors: [{ messageId: 'devOnly', data: { name: 'ws', member: MEMBER } }],
    },
    {
      // Under verbatimModuleSyntax this still emits `import {} from 'ws'`.
      filename: source,
      code: "import { type WebSocket } from 'ws';",
      errors: [{ messageId: 'devOnly', data: { name: 'ws', member: MEMBER } }],
    },
    {
      filename: source,
      code: "export { WebSocket } from 'ws';",
      errors: [{ messageId: 'devOnly', data: { name: 'ws', member: MEMBER } }],
    },
    {
      filename: source,
      code: "const ws = await import('ws');",
      errors: [{ messageId: 'devOnly', data: { name: 'ws', member: MEMBER } }],
    },
    {
      filename: source,
      code: "import lodash from 'lodash';",
      errors: [{ messageId: 'undeclared', data: { name: 'lodash', member: MEMBER } }],
    },
    {
      filename: source,
      code: "export * from 'lodash/fp';",
      errors: [{ messageId: 'undeclared', data: { name: 'lodash', member: MEMBER } }],
    },
    {
      filename: source,
      code: "import { createPtySupervisor } from '@agentplex/pty';",
      errors: [{ messageId: 'undeclared', data: { name: '@agentplex/pty', member: MEMBER } }],
    },
    {
      filename: source,
      code: "import { other } from '@scope/other/sub';",
      errors: [{ messageId: 'undeclared', data: { name: '@scope/other', member: MEMBER } }],
    },
    ...testFiles.map((filename) => ({
      filename,
      code: "import lodash from 'lodash';",
      errors: [{ messageId: 'undeclared', data: { name: 'lodash', member: MEMBER } }],
    })),
    {
      // A manifest that cannot be read fails closed: every import in the file
      // is reported rather than every import being let through.
      filename: join(tree, 'broken/src/a.ts'),
      code: "import 'zod';",
      errors: [{ messageId: 'unreadable' }],
    },
    {
      filename: join(tree, 'misshapen/src/a.ts'),
      code: "import 'zod';",
      errors: [{ messageId: 'unreadable' }],
    },
  ],
});
