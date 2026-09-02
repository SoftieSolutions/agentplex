import js from '@eslint/js';
import globals from 'globals';
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
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
