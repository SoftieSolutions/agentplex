# Hub storage: SQLite, completely

Supersedes the storage decisions in `2026-09-01-agentplex-v2-design.md`. That
document is history and is not edited; this one records what changed and why.

Status: proposed, 2026-09-03. Nothing here is built.

## The decision

The hub stores its state in SQLite, through `node:sqlite`. Postgres is removed
rather than kept as an alternative: the `pg` dependency, the compose service,
the testcontainer, and the Postgres dialect all go.

Removing it is the point. Supporting both would mean two dialects and two
migration histories that must stay semantically identical forever, checked by
nobody, diverging the first time somebody adds a column in a hurry. That is a
worse position than either database alone, and it is the position a project
drifts into by default when it declines to choose.

## Why the hub does not need Postgres

The hub is a coordination database for one person's machines. It holds paired
servers, the stores they report, a node tree, push subscriptions, and tokens.
The write pattern is whole-snapshot replacement from a handful of connection
supervisors -- the v2 design already requires that rows are replaced whole and
never merged field by field -- and the read pattern is a listing per connected
client. There is no query here that Postgres is better at.

What Postgres does bring is a network service, a second runtime to install, a
password to manage, and a container. Every one of those is a cost paid on every
installation to buy capacity this workload will not use.

## What removing it buys

**The dependency that forces Docker disappears.** This is the load-bearing
consequence. The server role cannot usefully run in a container: it exists to
drive PTYs against the machine's real filesystem and the operator's real agent
credentials, which is why `2026-09-01` already concedes bare metal as the
equally supported path for it. If the hub needs Postgres, a one-box install
means a container *and* a native process, two runtimes and two upgrade paths, to
buy nothing but database packaging. With SQLite, `--role=both` is one native
process and one file. The install design in
`2026-09-03-install-and-provisioning-design.md` depends on this and is not
worth building without it.

**The test story stops being conditional.** `AGENTS.md` currently has to warn
that the database suites take `AGENTPLEX_TEST_DATABASE_URL` when set, start a
testcontainer when it is not, and "with neither they skip themselves loudly, so
a green run that never reached a database has not tested them." A green run that
tested nothing is the failure mode that warning exists to catch, and the warning
is the best available answer only while the database is a network service. A
temp file or `:memory:` has no such mode: the suites run, always, everywhere,
with no Docker and no environment variable. That caveat leaves `AGENTS.md`, and
`@testcontainers/postgresql` leaves the dependency tree, taking the
dockerode/ssh2 subtree and three of the `allowBuilds` justifications with it.

**Epoch milliseconds become the only representation of time.** Everything above
the database already deals in epoch ms with an injected clock --
`StatusObservation.now`, `DiscoveredSession.updatedAt`, the staleness labels on
projections. `timestamptz` was the one place a second representation existed,
and it existed because Postgres offered it. Integer columns are more consistent
with the code above them, not a concession.

**Backup is a file copy**, and `node:sqlite` exposes a real online `backup` for
the case where the hub is running.

## What it costs

Stated plainly, because these are the reasons somebody would say no.

**One writer.** SQLite serializes writes. The hub must open its database in WAL
mode with a deliberate `busy_timeout`, and concurrent snapshot writes from N
server supervisors will serialize behind each other. At the scale this hub
operates -- a handful of paired machines, a few hundred sessions -- that is not
a bottleneck. It is a hard ceiling if the hub ever becomes multi-process.

**`DatabaseSync` is synchronous.** Wrapping it in the existing async `Database`
interface is trivial, but every query occupies the event loop for its duration,
so query cost has to stay bounded. The queries here are small and the
alternative -- a connection pool with its own failure modes -- is not obviously
better at this size.

**It closes a door.** A hosted, multi-tenant, horizontally scaled hub on a
managed database is off the table without replacing this layer. That is an
acceptable trade for a self-hosted tool and it is recorded here so that the
trade is a decision somebody made rather than a constraint somebody discovers.

## Verified, not assumed

Run at the origin on Node 24.18.1, which is the version the Dockerfile pins and
the version `@types/node` targets. `node:sqlite` exports `DatabaseSync`,
`StatementSync`, `Session`, `constants` and `backup`.

The hub schema was translated -- `timestamptz` to integer epoch ms, `boolean` to
integer -- and every constraint the design relies on was exercised:

- the single-row `CHECK` refuses a second `hub_identity` row;
- `servers_token_matches_liveness` refuses a live row without a token and a
  revoked row that kept one;
- the partial unique index refuses a second live pairing for one `server_id`
  and permits re-pairing after a revoke, which is the token-rotation case
  migration `0002` was written to allow.

Partial indexes, named table constraints and `length()` checks all survive. No
constraint in the current schema is lost in translation, which is the fact that
makes this a driver change rather than a redesign.

## What changes below the seam, and what does not

`src/hub/db/database.ts` states its own contract: "Everything above this line
talks to `Database`; exactly one module below it (`postgres.ts`) names the
driver. A test supplies its own implementation, and swapping drivers touches one
file." That is the whole reason this is affordable. `postgres.ts` is replaced by
`sqlite.ts`; `fake-database.ts` and every caller above are untouched.

One part of the seam should not survive unexamined. `DatabaseSession` exists
specifically because "Postgres has state that lives on a connection rather than
in the database: an advisory lock belongs to the backend that took it." With a
single file there is no pool, no backend, and no advisory lock; migration
serialization is `BEGIN IMMEDIATE`. The pinned-connection concept therefore has
no job left, and the interface should be narrowed to say so rather than kept as
a shape whose reason has evaporated. Leaving it in place would be the more
dangerous option: the next reader would assume it means something.

This obsoletes AGX-55 ("Migration advisory lock: pin it to one connection")
outright. It should be closed with a pointer here, not silently dropped.

## The migration rule, and the one exception

`AGENTS.md` is unambiguous: "Migrations are forward-only and append-only. There
is no `down`. An applied migration is history: add a new one rather than editing
it." Changing dialects means rewriting `0001` and `0002` rather than appending,
which the rule forbids.

The exception is narrow and it is bounded by time rather than by judgment. That
rule protects databases that exist in the field. At milestone 1 the only
databases are development boxes and CI, and the hub has never been deployed by
anybody. The exception is available exactly while that is true, and it expires
the first time a hub runs somewhere that matters. It is not precedent for
editing a migration later, and any future citation of this paragraph for that
purpose is a misreading.

The practical consequence is that this work is cheapest today and gets
monotonically more expensive. `master` holds one migration; AGX-22 adds a
second and is in review. Every schema ticket after this one that lands on
Postgres is work done twice.

## Docker after this

Compose loses the Postgres service, its healthcheck, and the `depends_on`
condition the hub needed in order to migrate before listening. What remains is
the hub container and optionally Caddy, with a volume for the database file.
Docker stops being the way to run agentplex and becomes one way: the right one
for a hosted hub or a machine that already runs containers, and no longer the
price of entry for someone with a spare LXC.

The claim in `docs/install.md` that "the hub belongs in a container: it is a
network service with one dependency and no business touching the host" was
sound when the hub was assumed to be alone on its box. Once `--role=both` is the
common installation it is not, and that passage changes with this work rather
than being left to contradict the installer.

## Work

1. `sqlite.ts` under the existing `Database` seam: WAL, `busy_timeout`, the
   sync-to-async wrapper, `backup` exposed for operational use.
2. Narrow `DatabaseSession` to what a single-file database can mean; close
   AGX-55.
3. Rewrite `0001` and `0002` in one dialect, epoch-ms columns, under the
   exception above. The constraint design and its commentary port verbatim;
   only the types and the defaults change.
4. Delete `pg`, `@types/pg`, `@testcontainers/postgresql`, `test-database.ts`'s
   container path, and the three `allowBuilds` entries that arrived under
   testcontainers.
5. Compose and Dockerfile: drop Postgres, add the database volume.
6. `AGENTS.md`: delete the conditional-database caveat, which is the point of
   doing this. `docs/install.md`: replace the container claim and the Postgres
   configuration.
