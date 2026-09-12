# Contributing to agentplex

## Getting set up

Docker is the primary path; Node 24 and pnpm 11 are the alternative.

```sh
pnpm install
pnpm check          # build, lint, typecheck, test — the same set CI runs
pnpm docker:check   # the same, in a container
```

`pnpm check` runs the whole set, starting with the build, because typecheck and
tests both resolve `@agentplex/protocol` through its built declarations. Run it
before opening a pull request; CI runs exactly the same tasks, so a green local
run should mean a green CI run.

CI runs them as four separate jobs — `build`, then `lint`, `typecheck` and
`test` in parallel — so a red pull request names the check that failed instead
of just the run. Each has a container-backed counterpart you can run on its
own, which is what to reach for when one job is red and the others are green:

```sh
pnpm docker:lint
pnpm docker:typecheck
pnpm docker:test
```

Two further checks are about what a stranger gets rather than about this tree,
and CI runs each under its own name for that reason:

```sh
pnpm docker:install    # the published package, installed by a bare npm
pnpm docker:bootstrap  # install.sh, on a Debian container with no Node on it
pnpm lint:shell        # shellcheck over install.sh
```

`pnpm lint:shell` is deliberately not part of `pnpm lint`: the image the checks
run in is a Node image, and adding shellcheck to it to lint one file is a worse
trade than a second command. CI runs it on the runner, which ships one.

## The shape of the codebase

A few rules carry most of the weight. They are not style preferences; each one
is here because the alternative failed quietly somewhere.

**Parse, never cast.** A word read off disk, off the network, or out of another
program is a claim. It goes through a parser that can say no. `as SomeType` on
external input is the bug, not the fix.

**Inject what a test cannot supply.** Sockets, clocks, filesystems, id sources
and the database arrive as dependencies. A module that reaches for the real
world directly is a module that can only be tested against the real world.
Prefer an injected seam to a mock.

**Fixtures are captured real output.** A hand-written fixture tests your idea of
the format. Capture the actual bytes.

**Degrade in the direction that does not over-claim.** A stale cache is served
stale and labelled with its age. A failed refresh writes nothing. An unreadable
item in a listing costs itself and not the listing.

**One parser per direction.** Each half of the protocol owns exactly one parser,
and nothing downstream re-checks a frame's `type` by hand.

**No frame carries an operation name, an argv element, an env var, or a cwd.**
Every spawn goes through the operation registry, `shell: false` always. A
generic `{ command }` frame is the failure mode the registry exists to prevent.

**Setup's spawns go through a second registry, not a wider one.** Installing a
provider is a spawn, so it obeys every rule above, and it is registered where
the wire cannot reach it: `createSetupOperationRegistry` is constructed on the
setup path only, and the wire-facing registry does not contain
`provider.install` at all. A long-running daemon that can be asked over a socket
to fetch and execute an installer is exactly what the previous rule exists to
prevent, and two disjoint lists say so in a way a flag could not. A test asserts
the disjointness over whatever both registries hold.

**Migrations are forward-only and append-only.** There is no `down`. An applied
migration is history: add a new one rather than editing it.

**No emojis in code or UI copy.**

## Workspace boundaries

Both apps may depend on `@agentplex/protocol`. Nothing else crosses a package
line, and neither app may import the other. `pnpm lint` enforces this.

`packages/protocol` is shared by a Node service and a browser bundle, so it may
use neither Node builtins nor another workspace package.

One boundary is not a package line, and so is not lint's to carry. `agentplex
doctor` reads a machine and must not be able to change it, and it lives in a
directory of `apps/cli` — an app that declares `@agentplex/pty` legitimately,
because the wizard beside it opens terminals. ESLint sees one file at a time, so
a rule scoped to the doctor's directory catches a direct import and misses one
reached through any sibling module in the same app.
`apps/cli/src/commands/doctor/pty-boundary.test.ts` is the half that holds the
property: it follows the import graph out of the doctor's entrypoint and fails
if any module in it binds anything from that package beyond the three names that
ask whether a pty can be opened without being able to open one. A constraint
that cannot be drawn at a package line gets a test, not a comment — a
half-enforced rule is worse than an unenforced one, because the second gets read
and the first gets trusted.

## Commits and pull requests

One ticket per branch, one branch per pull request. Keep the diff reviewable:
if a change needs a paragraph of context, that paragraph belongs in the pull
request body.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE).
