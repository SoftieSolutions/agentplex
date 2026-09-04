import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Workspace boundaries (AGX-9).
 *
 * The dependency graph is a tree, not a mesh: both apps may depend on the
 * protocol package, and nothing else crosses a package line. Enforcing it here
 * means a violation fails on the contributor's machine and in CI, rather than
 * being discovered when someone tries to split the packages apart.
 */
const forbidAppInternals = {
  group: ['**/apps/*/src/**', 'agentplexd/*', '@agentplex/web*'],
  message: 'Apps do not import each other. Share through @agentplex/protocol instead.',
};

const restrictedImports = (extra) => ['error', { patterns: [forbidAppInternals, ...extra] }];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': restrictedImports([]),
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // The protocol package is a leaf: it depends on neither app, and on no
    // runtime that only one of them has.
    files: ['packages/protocol/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      // Node globals, not just Node imports. `types: []` in this package's
      // tsconfig does not keep them out: vite's declarations reach the program
      // through vitest and carry a `/// <reference types="node" />`, which
      // re-injects @types/node whatever the types array says. So a bare
      // `process.env` typechecks cleanly here, and lint is what catches it.
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', '__dirname', '__filename', 'global', 'setImmediate'].map(
          (name) => ({
            name,
            message: `packages/protocol is bundled into a browser: ${name} does not exist there.`,
          }),
        ),
      ],
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['node:*', '@agentplex/*'],
          message:
            'packages/protocol is shared by a Node service and a browser bundle: it may use neither Node builtins nor another workspace package.',
        },
      ]),
    },
  },
  {
    files: ['apps/agentplexd/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Every spawn goes through the operation registry (AGX-21), and a rule
      // that only lives in a document is a rule that gets forgotten under
      // deadline. The registry's guarantees — a typed parser, a built argv, no
      // shell, no cwd, no env off the wire — are worth exactly as much as the
      // number of places that can start a child without it, so that number is
      // one, and it is this rule that keeps it one.
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['node:child_process', 'child_process'],
          message:
            'Starting a child directly bypasses the operation registry. Add an operation in src/server/operations/ and run it through the injected ProcessRunner.',
        },
      ]),
    },
  },
  {
    // The one exception, and the reason the rule can be absolute everywhere
    // else: this file *is* the seam. It is where `shell: false` is baked in and
    // where the inherited environment is decided, and it does nothing else.
    files: ['apps/agentplexd/src/server/operations/node-process-runner.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports([]) },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The REACT DIRECTIVES in AGENTS.md were enforced by nothing until this.
      // Two rules, not the plugin's recommended set: the rest of what it ships
      // is React Compiler analysis, which is a decision of its own and not one
      // this ticket is making.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // The design-system seam (AGX-30). Mantine enters the app through the
    // pass-through module in src/ui/ and nowhere else, so replacing it later
    // is an edit to one directory instead of a migration. The seam is worth
    // exactly as much as this rule: an unenforced boundary erodes one
    // convenient direct import at a time.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/ui/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['@mantine/*'],
          message:
            'Mantine is behind the pass-through in apps/web/src/ui/. Import from there, adding a re-export if the component is new to the app.',
        },
      ]),
    },
  },
  {
    // Hues are named once, in src/ui/tokens.ts (AGX-30). A color literal
    // anywhere else is a second place a hue lives, which is how palettes
    // drift. Status is expressed as a semantic tone through colorForTone.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/ui/tokens.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message:
            'Color literals live in apps/web/src/ui/tokens.ts and nowhere else. Name the hue there, or ask for a semantic tone via colorForTone.',
        },
      ],
    },
  },
  {
    // The service worker is a plain script served from public/, outside the
    // module graph, so it declares its own globals here.
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Tests and the support modules they import. `test-*.ts` is the same set
    // `tsconfig.build.json` excludes, so nothing matched here reaches `dist/`.
    // Install-time and tooling scripts match wherever they live: they run
    // under Node and their whole job is to say what they changed.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test-*.ts', '**/scripts/**/*.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
