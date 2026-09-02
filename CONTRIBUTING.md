# Contributing to agentplex

## Getting set up

Docker is the primary path; Node 24 and pnpm 11 are the alternative.

```sh
pnpm install
pnpm check          # build, lint, typecheck, test — the same set CI runs
pnpm docker:check   # the same, in a container, with a real Postgres
```

`pnpm check` runs the whole set, starting with the build, because typecheck and
tests both resolve `@agentplex/protocol` through its built declarations. Run it
before opening a pull request; CI runs exactly the same tasks, so a green local
run should mean a green CI run.

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

**Migrations are forward-only and append-only.** There is no `down`. An applied
migration is history: add a new one rather than editing it.

**No emojis in code or UI copy.**

## Workspace boundaries

Both apps may depend on `@agentplex/protocol`. Nothing else crosses a package
line, and neither app may import the other. `pnpm lint` enforces this.

`packages/protocol` is shared by a Node service and a browser bundle, so it may
use neither Node builtins nor another workspace package.

## Commits and pull requests

One ticket per branch, one branch per pull request. Keep the diff reviewable:
if a change needs a paragraph of context, that paragraph belongs in the pull
request body.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE).
