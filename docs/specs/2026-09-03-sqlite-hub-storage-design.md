# Hub storage: SQLite, completely

The storage layer for the hub: what the database is, why a file is the right
shape for this workload, what that costs, and what the seam above it promises.
Read with `2026-09-01-agentplex-v2-design.md`, which this document details.

Status: accepted, 2026-09-03.

## The decision

The hub stores its state in SQLite, through `node:sqlite`. One database, one
dialect, one migration history. There is no second supported engine and no
dialect abstraction, because supporting two would mean two migration histories
that must stay semantically identical forever, checked by nobody, diverging the
first time somebody adds a column in a hurry. That is a worse position than
either database alone, and it is the position a project drifts into by default
when it declines to choose.

## Why a file fits this workload

The hub is a coordination database for one person's machines. It holds paired
servers, the stores they report, a node tree, push subscriptions, and tokens.
The write pattern is whole-snapshot replacement from a handful of connection
supervisors -- the v2 design already requires that rows are replaced whole and
never merged field by field -- and the read pattern is a listing per connected
client. Every query is a keyed lookup or a small scan.

A network database would answer none of those better, and each one costs the
same on every installation: a service to run, a runtime to install, a password
to manage, a container. Those are paid to buy capacity this workload will not
use.

## What that buys

**Nothing forces Docker.** This is the load-bearing consequence. The server role
cannot usefully run in a container: it exists to drive PTYs against the
machine's real filesystem and the operator's real agent credentials, which is
why `2026-09-01` concedes bare metal as the equally supported path for it. If
the hub needed a database service, a one-box install would mean a container
*and* a native process -- two runtimes and two upgrade paths -- to buy nothing
but database packaging. As it is, `--role=both` is one native process and one
file. The install design in `2026-09-03-install-and-provisioning-design.md`
depends on this.

**The test story is unconditional.** A database that is a temp file or
`:memory:` has no environment in which its suites quietly do not run. The
migration and query suites open one and run: on a laptop, in CI, in the check
container, with no Docker and no environment variable to set. A green run that
tested nothing is the failure mode a network-service database has to be warned
about; here there is nothing to warn about.

**Epoch milliseconds are the only representation of time.** Everything above the
database deals in epoch ms with an injected clock -- `StatusObservation.now`,
`DiscoveredSession.updatedAt`, the staleness labels on projections. Integer
columns keep the database consistent with the code above them, and a time value
crosses no representation boundary on its way in or out.

**Backup is a file copy**, and `node:sqlite` exposes a real online `backup` for
the case where the hub is running.

## What it costs

Stated plainly, because these are the reasons somebody would say no.

**One writer.** SQLite serializes writes. The hub opens its database in WAL mode
with a deliberate `busy_timeout`, and concurrent snapshot writes from N server
supervisors serialize behind each other. At the scale this hub operates -- a
handful of paired machines, a few hundred sessions -- that is not a bottleneck.
It is a hard ceiling if the hub ever becomes multi-process.

**`DatabaseSync` is synchronous.** Wrapping it in the async `Database` interface
is trivial, but every query occupies the event loop for its duration, so query
cost has to stay bounded. The queries here are small and the alternative -- a
connection pool with its own failure modes -- is not obviously better at this
size.

**It closes a door.** A hosted, multi-tenant, horizontally scaled hub on a
managed database is off the table without replacing this layer. That is an
acceptable trade for a self-hosted tool, and it is recorded here so that the
trade is a decision somebody made rather than a constraint somebody discovers.

## Verified, not assumed

Run at the origin on Node 24.18.1, which is the version the Dockerfile pins and
the version `@types/node` targets. `node:sqlite` exports `DatabaseSync`,
`StatementSync`, `Session`, `constants` and `backup`.

Every constraint the schema design relies on was exercised against it:

- the single-row `CHECK` refuses a second `hub_identity` row;
- `servers_token_matches_liveness` refuses a live row without a token and a
  revoked row that kept one;
- the partial unique index refuses a second live pairing for one `server_id`
  and permits re-pairing after a revoke, which is the token-rotation case
  migration `0002` was written to allow.

Partial indexes, named table constraints and `length()` checks are all
available. The schema the hub wants is the schema SQLite gives it; nothing in
the constraint design is expressed in application code for want of a database
that can hold it.

## The seam

`src/hub/db/database.ts` states its own contract: everything above it talks to
`Database`, exactly one module below it (`sqlite.ts`) names the driver, and a
test supplies its own implementation. `fake-database.ts` is that
implementation, and no caller above the seam knows what is underneath.

The interface has three verbs -- query, transaction, close -- and deliberately
not a fourth for a connection pinned across a body. One file means one
connection, so every handle is already pinned and the verb would distinguish
nothing. The one caller that would reach for it is the migration runner, and it
does not need one: `BEGIN IMMEDIATE` takes the database's write lock at the
first statement rather than at the first write, so a second hub process
starting against the same file waits on the busy timeout and then fails,
instead of interleaving its DDL. An interface that promises a guarantee it
cannot describe is worse than one that does not offer it, so the verb is absent
rather than present and meaningless.

Migrations are forward-only and append-only, and the whole run is one
transaction. That is stronger than one transaction per migration: a run that
fails halfway leaves the schema exactly where it started, so the next start
applies the same list again rather than resuming into a state nobody wrote
down. Holding the write lock for the run is affordable because migrating
happens before the hub listens.

## Docker

Compose is the hub container and optionally Caddy, with a named volume for the
database file. There is no database service, no healthcheck for one, and no
`depends_on` condition the hub must wait on before it can migrate and listen.

Docker is therefore one way to run agentplex rather than the way: the right one
for a hosted hub or a machine that already runs containers, and not the price
of entry for someone with a spare LXC. `docs/install.md` documents both paths
as first-class, because once `--role=both` is the common installation, "the hub
belongs in a container" is a deployment preference and not a property of the
system.

## Shape of the implementation

1. `sqlite.ts` under the `Database` seam: WAL, `busy_timeout`, the
   sync-to-async wrapper, `backup` exposed for operational use.
2. Migrations as `.sql` files read from disk, ordered by version, applied in
   one transaction and recorded in a bookkeeping table.
3. Configuration is `--database-file` / `AGENTPLEX_DATABASE_FILE`: one absolute
   path, required for the `hub` and `both` roles.
4. Compose and Dockerfile: the hub, Caddy, and a named volume holding the
   database file plus its `-wal` and `-shm`.
