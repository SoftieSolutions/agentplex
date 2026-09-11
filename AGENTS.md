# REPOSITORY DESCRIPTION

agentplex watches and drives coding-agent sessions across machines. One bin,
`agentplex`, whose subcommands are `setup` (the wizard), `doctor` (the
read-only check) and `help`. `hub` and `server` are daemons and not commands:
nobody types either, systemd starts them from their units and `pnpm start` does
in development, so the bin reaches no app's build output. `web` is a React PWA
the hub serves.

Four published packages, one per app: `@softiesolutions/agentplex` (the bin),
`-hub`, `-server`, `-web`. `install.sh --role=hub|server|both` decides which a
machine installs and which units it gets; the bin goes on every machine and
`web` is part of being a hub. The point is what a hub stops carrying: the hub
and web packages reach node-pty nowhere and the bin's declares it optional, so
no package a hub installs can fail for want of a C++ compiler. Only the server
package requires it.

The hub owns the database, serves the client, and merges what every paired
server reports. A server runs sessions through a PTY and watches a store on
disk, holds no database, and dials out to nothing — the hub dials it. A
session's identity is `{ storeId, sessionId }`, never the machine.

## FOLDER STRUCTURE

- `apps/` holds deployables: `hub`, `server`, `cli`, `web`. An app is a thing
  that runs. `apps/cli` owns the bin and `apps/cli/src/commands/` holds a
  subcommand. Nothing imports an app, and nothing reaches into one by path.
- `apps/web` carries its published name in the workspace, because the hub finds
  the client by resolving that one specifier — the same in a checkout, the image
  and `lib/node_modules`. A file location, not an import: the hub loads no
  module out of it, and with no client package it warns once and serves 503.
- `scripts/` holds the repository's own tooling — the bootstrap an operator
  curls, the packaging step that composes the apps' built output by path, never
  by import. Nothing ships from it, and it is a workspace member because
  `pnpm test` is `pnpm -r test`: a suite outside a member runs nowhere.
- `packages/` holds seams with at least two consumers: `protocol`,
  `node-shared`, `providers`, `pty`. A package's dependency list is its
  allowed import set. One consumer means a folder, not a package. `pnpm lint`
  enforces both rules.
- `packages/protocol` is bundled into a browser as well as loaded by a service,
  so it may use neither Node builtins nor another workspace package.
- `tests/hub-server` is the one place both apps load into one process: the hub
  driven against the real server end of its protocol. No other directory may
  cross an app boundary.
- Setup opens no database. It writes files; the hub imports the local pairing
  at boot.
- A package exports its fakes from a `testing` entry. A fake is never copied.
- Test files sit next to the file under test: `config.test.ts` beside
  `config.ts`. No `__tests__` directory. Tests are linted and typechecked like
  any other source.

## COMMANDS

- `pnpm check` — build, lint, typecheck, test. CI runs the same set as four
  jobs: `build`, then `lint`, `typecheck` and `test` in parallel.
- `pnpm docker:check` — the same in a container; `docker:lint` /
  `docker:typecheck` / `docker:test` run one check alone.
- Docker is the primary path for the checks and for a hosted hub, not the price
  of entry: the database is a file, so one machine runs both daemons natively.

## DEPENDENCIES DIRECTIVES

- pnpm, always. The version is pinned in `packageManager` and read by corepack,
  so the runner and the image cannot end up on different ones.
- Install the latest version of a new dependency and pin it deliberately, and
  `@types/<package>` with it when the package ships no types.
- Root dependencies are dev tooling only. Anything an app or package imports is
  declared in that app or package.
- A postinstall script runs only for packages listed in `allowBuilds` in
  `pnpm-workspace.yaml`. Adding one grants that package arbitrary code execution
  at install; do it deliberately.
- No internal barrel files (a package entry point is not one), no cycles.

## GIT DIRECTIVES

- `master` is the main branch.
- One ticket per branch, one branch per pull request. Never commit to `master`.
- Every task gets its own worktree, cut before the first edit. They live where
  `.claude/settings.json` points, which is outside this repository.
- A fresh worktree has no `node_modules`: run `pnpm install` in it before
  testing, or the first run fails on something unrelated-looking.
- When tickets form a dependency chain, stack the pull requests — each based on
  the previous — rather than forcing parallel branches that re-create each
  other's work and conflict on merge.
- Never `git add -A` without reading `git status` first.
- Commit messages and pull request bodies explain the decisions and why. The
  argument belongs there, not in a comment.

## AI DIRECTIVES

- Never use emojis, in code, in documentation, or in UI copy.
- Ask when a task is ambiguous rather than guessing. Do not invent an answer to
  an open question; surface it.
- Test-driven where it fits: write the test before the implementation.
- Run the affected tests before calling anything done, and fix every lint and
  type error first. A claim about what a runtime offers is not settled until it
  has been run at the origin.
- `AGENTS.md` is the single source of truth. `CLAUDE.md` imports it and adds
  nothing but Claude-specific notes. Editing this file means removing
  something: it is loaded into every session, so it has a size budget rather
  than an append log. A gotcha that bites silently and a tradeoff somebody had
  to argue out earn a place here; anything inferable from the code does not.

## CODE DIRECTIVES

The rules below are the ones that cost something to learn. `CONTRIBUTING.md`
carries the argument for each.

- **Parse, never cast.** A word read off disk, off the network, or out of
  another program is a claim. It goes through a parser that can say no.
- **Inject what a test cannot supply** — sockets, clocks, filesystems, id
  sources, the database. Prefer an injected seam to a mock.
- **Fixtures are captured real output**, never hand-written.
- **Degrade in the direction that does not over-claim.** A stale cache is
  labelled with its age. An unreadable item in a listing costs itself, not the
  listing.
- **One parser per protocol direction**, and nothing downstream re-checks a
  frame's `type` by hand.
- **No frame carries an operation name, an argv element, an env var, or a cwd.**
  Every spawn goes through the operation registry, `shell: false` always.
- **Migrations are forward-only and append-only.** There is no `down`. An
  applied migration is history: add a new one rather than editing it.
- Export interfaces from the file that defines them. Types live near what they
  describe, not in a shared types dump.

## REACT DIRECTIVES

- Named functions for components, not arrow constants assigned to a name.
- A function that can live outside a component body does. Mark with a comment
  when one is genuinely needed inside.
- `useEffect` requires explicit justification. Prefer `useSyncExternalStore`,
  ref callbacks, and render-time guards.
- Terminal bytes never enter React state; they go to the emulator.
- Status is a semantic tone. Hues are named in one tokens file and nowhere else.
