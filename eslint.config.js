import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Workspace boundaries (AGX-9).
 *
 * The dependency graph is a tree, not a mesh: an app may depend on the
 * packages its manifest names, a package on the ones its manifest names, and
 * nothing else crosses a package line. Enforcing it here
 * means a violation fails on the contributor's machine and in CI, rather than
 * being discovered when someone tries to split the packages apart.
 */
const forbidAppInternals = {
  group: ['**/apps/*/src/**', 'agentplex/*', '@agentplex/web*'],
  message: 'Apps do not import each other. Share through @agentplex/protocol instead.',
};

const restrictedImports = (extra) => ['error', { patterns: [forbidAppInternals, ...extra] }];

/**
 * The narrowing that keeps the doctor unable to open what it inspects, named
 * here because two configurations below need exactly it: the program, and the
 * one suite of its own that is allowed to start a child.
 */
const doctorOpensNoPty = [
  {
    group: ['@agentplex/pty/*'],
    message: 'The doctor reads a machine and opens no pty. It may not import @agentplex/pty.',
  },
  {
    group: ['@agentplex/pty'],
    allowImportNames: ['checkNodePty', 'NODE_PTY_REMEDY', 'PtyAvailability'],
    message:
      'The doctor may ask whether a pty can be opened -- checkNodePty, NODE_PTY_REMEDY, PtyAvailability -- and may import nothing from @agentplex/pty that could open one.',
  },
];

export default tseslint.config(
  {
    // `apps/install/release` is the staged package: every file in it is a
    // copy of something already linted where it was written.
    ignores: ['**/dist/**', '**/coverage/**', '**/*.d.ts', 'apps/install/release/**'],
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
    // A package's dependency list is its allowed import set (AGX-91). This one
    // is the seam the hub and the server share -- clocks, ids, the logger, the
    // message socket -- and it may reach only `protocol` in the workspace: a
    // dependency on `providers` or `pty` would put the seam above the things
    // that are supposed to sit on it.
    files: ['packages/node-shared/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['@agentplex/*', '!@agentplex/protocol'],
          message:
            'packages/node-shared may import @agentplex/protocol and no other workspace package.',
        },
        {
          group: ['node:child_process', 'child_process'],
          message:
            'Starting a child directly bypasses the operation registry. Nothing in node-shared spawns.',
        },
      ]),
    },
  },
  {
    // The provider seam: adapters, the process runner they probe and provision
    // through, and the store identity a provider's discovery is made durable
    // by. Below `pty`, which takes an adapter's launch plan, and above
    // `node-shared`; the manifest says the same in its dependency list.
    files: ['packages/providers/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['@agentplex/*', '!@agentplex/protocol', '!@agentplex/node-shared'],
          message:
            'packages/providers may import @agentplex/protocol and @agentplex/node-shared and no other workspace package.',
        },
        {
          group: ['node:child_process', 'child_process'],
          message:
            'Starting a child directly bypasses the operation registry. Add an operation and run it through the injected ProcessRunner.',
        },
      ]),
    },
  },
  {
    // The pty seam, and the one package that loads node-pty. It takes an
    // adapter's launch plan, so it sits above `providers`; keeping the native
    // addon here means a consumer of the provider seam does not inherit a
    // toolchain requirement it does not use.
    files: ['packages/pty/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: [
            '@agentplex/*',
            '!@agentplex/protocol',
            '!@agentplex/node-shared',
            '!@agentplex/providers',
          ],
          message:
            'packages/pty may import @agentplex/protocol, @agentplex/node-shared and @agentplex/providers and no other workspace package.',
        },
        {
          group: ['node:child_process', 'child_process'],
          message:
            'Starting a child directly bypasses the operation registry. A pty is opened through the PtyFactory seam and nothing else.',
        },
      ]),
    },
  },
  {
    // The repository's own tooling, which is not service code and ships
    // nowhere. It gets the same spawn rule as an app anyway: the assembler
    // copies files and the bootstrap is a shell script, so nothing here has a
    // reason to start a child, and a rule that holds everywhere is cheaper to
    // trust than one with a tooling-shaped hole in it. The one suite that does
    // start a child is excepted below, by name.
    files: ['scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['node:child_process', 'child_process'],
          message:
            'Starting a child directly bypasses the operation registry. Add an operation and run it through the injected ProcessRunner.',
        },
      ]),
    },
  },
  {
    // The one place both apps are loaded into one process: the hub driven
    // against the real server end of its protocol. `tests/hub-server/README.md`
    // carries the argument. The crossing is allowed here and nowhere else, and
    // it is tests only: nothing in this directory ships.
    files: ['tests/hub-server/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        {
          group: ['node:child_process', 'child_process'],
          message: 'Starting a child directly bypasses the operation registry.',
        },
      ]).map((entry) =>
        typeof entry === 'object' ? { patterns: entry.patterns.slice(1) } : entry,
      ),
    },
  },
  {
    files: [
      'apps/hub/**/*.ts',
      'apps/install/**/*.ts',
      'apps/server/**/*.ts',
      'apps/setup/**/*.ts',
    ],
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
            'Starting a child directly bypasses the operation registry. Add an operation and run it through the injected ProcessRunner.',
        },
      ]),
    },
  },
  {
    // The doctor reads a machine and must not be able to change it: a check is
    // easier to trust when the program running it cannot open a pty or
    // provision. This is that rule made checkable rather than a dependency list
    // somebody has to remember.
    //
    // It declares `pty` for exactly three names, and the narrowing is the rule
    // rather than a hole in it. node-pty is an optional dependency of the
    // published package, so a machine can have everything but it, and a doctor
    // that could not ask would report a server as ready right up to the first
    // session that would not start. `checkNodePty` loads the addon and answers a
    // question; `createPtySupervisor` and `nodePtyFactory` are what could open
    // one, and neither is reachable from this program.
    files: ['apps/doctor/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports([
        ...doctorOpensNoPty,
        {
          group: ['node:child_process', 'child_process'],
          message: 'Starting a child directly bypasses the operation registry.',
        },
      ]),
    },
  },
  {
    // The one exception inside the service, and the reason the rule can be
    // absolute everywhere else in it: this file *is* the seam. It is where
    // `shell: false` is baked in and where the inherited environment is
    // decided, and it does nothing else.
    files: ['packages/providers/src/operations/node-process-runner.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports([]) },
  },
  {
    // The other exceptions, which are not service code at all. One suite's
    // subject is a shell script -- the bootstrap that installs the package on a
    // machine that does not have it yet -- and the other's is the `agentplex`
    // bin, whose behaviour *is* which stream a line landed on and what the exit
    // code was. For both, starting a child is the only way to have a subject.
    // The rule above is about what the daemon may do, and nothing here is
    // reachable from a socket, a frame or a running process.
    files: ['scripts/install.sh.integration.test.ts', 'apps/install/src/main.integration.test.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports([]) },
  },
  {
    // The third, for the same reason as the second. This suite's subject is an
    // install script that npm runs as a program and reads an exit code from, so
    // running it as a program is the only way to assert on the exit code. The
    // rule it lifts is about what a daemon may spawn, and nothing here is
    // reachable from a socket, a frame or a running process.
    files: ['packages/pty/scripts/node-pty-postinstall.test.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports([]) },
  },
  {
    // The fourth, and the same argument again: these suites' subject is a
    // program. Which stream a usage message came out on and which exit code the
    // operator's shell saw are facts about a process, so starting one is the
    // only way to have a subject at all -- and `--help` is the invocation that
    // binds no port, opens no database and asks nobody anything. The rule this
    // lifts is about what a daemon may spawn; nothing here is reachable from a
    // socket, a frame or a running process.
    files: [
      'apps/hub/src/main.integration.test.ts',
      'apps/server/src/main.integration.test.ts',
      'apps/setup/src/main.integration.test.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports([]) },
  },
  {
    // The doctor's half of that exception, which keeps the half that is about
    // the doctor: it may start the program under test, and it still may not
    // reach anything that could open a pty. A suite that could would be
    // asserting about a program other than the one that ships.
    files: ['apps/doctor/src/main.integration.test.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports(doctorOpensNoPty) },
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
