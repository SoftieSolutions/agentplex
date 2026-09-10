# Repository split

One app per thing that runs, one package per seam two apps share, and one
binary that an operator installs.

Depends on `2026-09-03-install-and-provisioning-design.md`: the installer, the
setup wizard, the plan file and the published package are what this document
rearranges. Supersedes the process-per-role half of "One codebase, role flags"
in `2026-09-01-agentplex-v2-design.md`, and keeps the other half: one codebase,
one release artifact, one thing for a self-hoster to install.

Status: proposed, 2026-09-10. Nothing here is built. Jira epic AGX-91.

## Why now

`2026-09-01` chose one process with `--role=hub|server|both` because splitting
the roles "buys ceremony, not isolation". That was true for the deployment it
had in mind: one machine, one operator, one process. The deployment this
document is for is different. A fleet of servers runs on EC2 instances, and the
hub and the PWA run on one local machine. In that shape every server is already
on a different machine from the hub, and the isolation is the product: a PTY
fault on one server must not be able to take the hub down, a hub restart must
not restart every session on every machine, and a server upgrade must not need
the hub to stop.

The same document said the roles "stay separable inside the codebase, so
splitting later is possible". Later is now. The import graph confirms it: the
hub and the server share nothing but `src/shared/`, and neither imports the
other outside a test.

## What an app is, and what a package is

The whole layout follows from two definitions.

**An app is a deployable.** It has an entrypoint, it is built to `dist/`, and
it ships. Nothing imports an app. The lint rule that says so exists today and
stays.

**A package is a seam with at least two consumers.** It is a library, it has a
dependency list, and that list is the set of things it may import. A package
with one consumer is a folder that has been given a `package.json`, and it
does not get one here.

Those two definitions decide every placement below. Where a placement is not
obvious, the argument is recorded beside it.

## The layout

```
apps/hub/           agentplex hub: database, migrations, pairing, discovery,
                    sessions, layout, clients, the PWA's bytes, later mcp/
apps/server/        agentplex server: terminals, session control, identity,
                    beacon, the hub connection
apps/setup/         agentplex setup and agentplex doctor
apps/install/       install.sh, the package assembler, the agentplex bin
apps/web/           the PWA, unchanged
packages/protocol/  frame types and parsers, unchanged
packages/node-shared/  clock, ids, logger, timers, tokens, message socket,
                    child environment
packages/providers/ the provider seam: adapter interface, registry,
                    preflight, provisioning, the Claude adapter, and the
                    process runner, probe and program resolver they need;
                    store identity and discovery
packages/pty/       the pty interface, its supervisor, the node-pty factory
```

Dependencies, and nothing else:

```
protocol      <- everything
node-shared   <- providers, pty, hub, server, setup
providers     <- pty, server, setup
pty           <- server, setup
```

`apps/install` depends on no workspace package at build time. It composes the
others' outputs, which is the subject of its own section.

### Why `node-shared` exists

Fourteen files, and the only thing hub and server have in common. It cannot
join `protocol`, which is bundled into a browser and may use no Node builtin.
It has four consumers, so it is a package by the definition above.
`child-environment` moves in with it: composing what a child inherits is done
by the process runner in `providers` and by the supervisor in `pty`, and both
have to compose it the same way.

### Why `providers` takes the process runner and the store identity

An adapter cannot compile alone. It probes a binary through the process probe,
resolves it through the program resolver, and runs it through the process
runner, and provisioning runs the same runner in the other direction. Those
seams go with the adapters because the alternative is a package whose every
consumer has to supply the same three things before it can call anything.

Store identity goes with the adapters because store discovery does: a provider
is what says where its sessions live, and the store file is how that answer is
made durable. The server reads store files and setup mints them, so the seam
has the two consumers a package needs.

The Claude adapter is in the package rather than in the server, which
`2026-09-01` argued against: adapters "live at `apps/agentplexd/src/server/
providers/` and move out only if a real second consumer appears". Setup is
that consumer. It adopts an installed provider, probes its version and logs it
in, all through the adapter. The condition the earlier document set has been
met.

### Why `pty` is separate from `providers`

The supervisor depends on the adapter's launch plan, so it cannot sit below
`providers`. It cannot sit inside it either without making every consumer of
the provider seam carry node-pty, which is the one native dependency in the
repository and the one that needs a toolchain. `node-pty` is declared in this
package and nowhere else, and the postinstall that repairs its spawn helper's
executable bit moves here with it. Two consumers, the server and setup, which
drives a provider's login through the same supervisor a session runs under.

### Fakes ship with their package

`fake-pty`, `fake-process-runner`, `fake-provider-adapter` and their kin are
used by tests in three of the apps. A fake is a captured, argued stand-in for a
real seam, and a second copy of one drifts from the first. Each package
exports its fakes from a `testing` entry point, beside the interfaces they
stand in for, so a test in any app reaches the one fake for a seam.

## Setup opens no database

Today setup imports the hub's database, migrations and pairing modules for one
purpose: in `--role=both` it writes the local server's pairing row into the
hub's database. As an app, setup may import none of that.

The relocation is small and keeps every bound AGX-75 argued. Setup writes
files. It already writes the server's identity file, with the pairing token in
it, and the settings the daemons start from. It now also writes the hub's
settings with a local-server entry: the identity file's path and the server's
port. At boot the hub reads that identity file, and if a registration for the
loopback address is absent or holds a different token, it writes one. The
exception to "pairing is always the user typing that server's token into the
hub" moves from setup to the hub's boot and keeps its shape:

- **Loopback, not an address.** The hub takes a port, and the address it
  registers comes from `loopbackServerAddress(port)`, which has nowhere to put
  a host.
- **A file, not a claim.** The token is read from the identity file setup
  wrote, through the same parser the server reads it with. Nothing arrives over
  a socket.
- **Configuration, not discovery.** The entry is a setting the operator's
  setup run wrote. A hub with no such setting registers nothing, and no other
  path can add one.
- **Idempotent.** A second boot finds the row and leaves it. A re-run of setup
  that minted a new token is reconciled at the next boot, and the reconciliation
  is logged.

The hub's database, its migrations and its pairing code then have exactly one
consumer and stay inside `apps/hub`.

## One binary from four apps

The operator installs one thing and runs one command. That has to survive the
split, and it does, because packaging is where composition happens.

```
agentplex hub       # the hub daemon
agentplex server    # the server daemon
agentplex setup     # the wizard, or --plan <file> to replay
agentplex doctor    # read-only check of this machine
```

The `agentplex` bin lives in `apps/install`. It is a dispatcher: it maps the
first argument to the matching app's built entry and imports it by path. It
imports nothing at build time, so the rule that apps do not import each other
holds in source; the assembled package is where four `dist/` directories sit
next to one another, exactly as the hub already reaches `apps/web/dist` by a
relative path and never by an import.

The package keeps the workspace layout, for the reason `assemble-package.ts`
already records: one set of relative paths, exercised from source, in the
image and in the published tarball alike. `apps/hub/dist/main.js` resolves its
migrations as `../migrations` and the client as `../../web/dist`, the same
distances `apps/agentplexd` resolves them from today.

The daemons take no `--role`. Which daemon runs is which subcommand was given.
`AGENTPLEX_ROLE` remains an installer fact: `install.sh --role` decides which
units get written and what setup is pre-seeded with, and that is the whole of
its meaning.

## Two units when both

`install.sh --role=both` writes `agentplex-hub.service` and
`agentplex-server.service`. `--role=server` writes the second, `--role=hub` the
first. Both read the one settings file the installer writes, and each reads
only the keys it needs, so a setting the other daemon owns is not an error.

Order does not matter. The hub dials the server and retries, so a server that
comes up second is dialled when it is there, and a server that comes up first
listens until it is.

The Docker image stays one image. Its entrypoint becomes `agentplex`, and the
command picks the daemon; the compose file's `hub` service says `hub`. A
container that wants both roles runs two services from the same image, which
is what a compose file is for.

## What the names become

The package and the bin are `agentplex`. `agentplexd` was the name of one
daemon, and there are now two. Environment variables keep the `AGENTPLEX_`
prefix. The settings file, the identity file and the prefix under
`~/.agentplex/` keep their paths, so a machine installed before this and
upgraded through it finds its files where they were.

## What does not change

- `packages/protocol`: a leaf, browser-safe, one parser per direction.
- `apps/web`: built by Vite, served by the hub, shipped in the package.
- The database: hub-owned, SQLite, single writer, migrations forward-only.
- Pairing across machines: the server mints its token, the operator types it
  into the hub's pairing form, the beacon pre-fills the address on one network,
  the plan carries a pre-minted token on a fleet.
- The operation registry: closed, `shell: false`, no frame carries an argv.
- Every rule in `AGENTS.md` under code, React and git.

## Order of work

Each step leaves `pnpm check` green and `apps/agentplexd` runnable, until the
last step removes it. The moves are mechanical and the order is the dependency
order, so no step waits on a step after it.

1. AGX-92: `packages/node-shared`: `src/shared/` and `child-environment`, with the
   lint rule that it may use Node and may import only `protocol`.
2. AGX-93: `packages/providers`: the adapters, the registry, preflight, provisioning,
   the process runner, probe and program resolver, store identity and
   discovery, and the `testing` entry.
3. AGX-94: `packages/pty`: the pty interface, supervisor and node-pty factory; the
   `node-pty` dependency and its postinstall move with it.
4. AGX-95: local pairing at hub boot, from the identity file setup names. Setup stops
   opening the database. This is the one behavioural change in the epic and it
   is done before any app is cut, while the tests for both sides are still in
   one place.
5. AGX-96: `apps/hub`: `src/hub/`, the hub's config, `migrations/`, its own entry.
6. AGX-97: `apps/server`: `src/server/`, the server's config, its own entry.
7. AGX-98: `apps/setup`: `src/setup/` and `doctor`, its own entry.
8. AGX-99: `apps/install`: packaging moves, the `agentplex` bin and its dispatch, the
   package renamed, `install.sh` writing one or two units, the image and the
   compose file, the docs, and the deletion of `apps/agentplexd`.

The stack is one chain, each pull request based on the previous, because each
step's imports are the previous step's exports.
