# agentplex

Watch and drive coding-agent sessions across machines, from a phone or a laptop.

agentplex runs your coding-agent sessions (Claude Code today; the provider seam
is first class) wherever they belong — a homelab box, a mac mini, an EC2
instance — and gives you one installable web app that sees all of them, tells
you which ones are waiting on you, and lets you answer from wherever you are.

> Status: early. Milestone 1 of the v2 design — the scaffold, protocol
> package, service skeleton and database — is what exists so far. It does not
> yet run sessions.

## How it fits together

```
phone PWA  ─┐
laptop PWA ─┼─ wss/https ─> HUB ── wss ─> SERVER ── pty/fs ─> sessions + store
MCP agent  ─┘                │             SERVER ─────────>  same or another store
                        SQLite file
```

- **hub** — owns the database, serves the web app, merges what every paired
  server reports, and is the only thing clients ever talk to.
- **server** — runs sessions on its own machine through a PTY and watches a
  store on disk. Stateless apart from that disk. It dials out to nothing; the
  hub dials it.
- **store** — a directory holding session transcripts, identified by an
  `agentplex-store.json` at its root. A session's identity is its store and its
  id within it, never the machine it happens to be running on.

One bin, `agentplex`. Its subcommands are `setup`, the wizard, and `doctor`,
the read-only check. `hub` and `server` are daemons rather than subcommands, and
nobody types either: `install.sh` writes a systemd unit per daemon the machine's
role runs, and `pnpm -C apps/hub start` is the same thing in a checkout. A
machine that runs both daemons starts one of each.

## What gets published

Four packages, one per app, so that a machine installs only what it runs.

| package                             | what it is                         | installed by                   |
| ----------------------------------- | ---------------------------------- | ------------------------------ |
| `@softiesolutions/agentplex`        | the bin: `setup`, `doctor`, `help` | every role                     |
| `@softiesolutions/agentplex-hub`    | the hub daemon and its migrations  | `--role=hub`, `--role=both`    |
| `@softiesolutions/agentplex-web`    | the built web app the hub serves   | with the hub                   |
| `@softiesolutions/agentplex-server` | the server daemon                  | `--role=server`, `--role=both` |

`web` is not a role: it is part of being a hub, and the hub finds it by
resolving that package name rather than by a path inside its own tree. A hub
that is missing it still runs, warns once at startup and answers the client
routes with `503`.

What a hub-only machine stops carrying is the point.
[node-pty](https://github.com/microsoft/node-pty), the native addon behind the
server's pseudoterminals, has no Linux prebuild, so it is compiled at install
time -- the step of any install most likely to fail. The hub and web packages
reach it nowhere and the bin's declares it optional, so nothing a hub installs
can fail for want of a compiler. It is a required dependency of the server
package, where a machine that cannot compile it fails the install rather than
reporting success and never opening a session.

## Repository layout

```
apps/hub/              the hub: database, migrations, pairing, discovery, the PWA's bytes
apps/server/           the server: terminals, session control, identity, beacon, the hub connection
apps/cli/              the agentplex bin, and the setup and doctor commands inside it
apps/web/              the PWA
packages/protocol/     frame types and parsers, shared by the service and the PWA
packages/node-shared/  clock, ids, logger, sockets: what the hub and the server share
packages/providers/    the provider seam, the process runner it needs, store identity
packages/pty/          the pty seam, its supervisor, and node-pty
scripts/               install.sh and the package assembler: this repository's own tooling
tests/hub-server/      the hub driven against the real server end, both in one process
```

A package is a seam with at least two consumers, and neither app may import
the other. That boundary is enforced by lint, not by convention.

## Running it

Docker is the right way to run a hosted hub, and requires only Docker with the
Compose plugin. Nothing in `.env` has to be set to try it on `localhost`.

```sh
cp .env.example .env
docker compose up -d   # the hub, and Caddy in front of it
curl -k https://localhost/health
```

One image serves both roles; the role is a runtime choice, by environment
variable or flag. Caddy is there only to terminate TLS with a certificate that
renews itself, because web push is HTTPS-only — if TLS is already handled,
`docker compose up -d hub` starts the hub and nothing else.

The hub's database is a SQLite file, so a container is packaging rather than a
dependency you could not otherwise satisfy: one machine can run `--role=both`
natively and never build an image.

Running the server role bare metal — `node` on a mac mini or a laptop, no
container — is equally supported, and often the better arrangement: the role
spawns sessions against the machine's real filesystem and credentials.

For working on the code, Node 24 and pnpm 11:

```sh
pnpm install
pnpm build
pnpm check          # lint, typecheck, test
pnpm docker:check   # the same, in a container
```

## Configuration

Every setting has one flag and one environment variable; the flag wins.

| Flag                     | Environment                      | Default               | Meaning                                                                                    |
| ------------------------ | -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `--role`                 | `AGENTPLEX_ROLE`                 | none, required        | `hub`, `server` or `both`                                                                  |
| `--host`                 | `AGENTPLEX_HOST`                 | `0.0.0.0`             | Interface to bind                                                                          |
| `--hub-port`             | `AGENTPLEX_HUB_PORT`             | `8080`                | Port the hub serves on                                                                     |
| `--server-port`          | `AGENTPLEX_SERVER_PORT`          | `8081`                | Port the hub dials                                                                         |
| `--database-file`        | `AGENTPLEX_DATABASE_FILE`        | none                  | SQLite file, absolute; required for `hub` and `both`                                       |
| `--client-token`         | `AGENTPLEX_CLIENT_TOKEN`         | none                  | Client credential, 32+ chars; required for `hub`, `both`                                   |
| `--store-path`           | `AGENTPLEX_STORE_PATH`           | none                  | Store root; repeatable, absolute                                                           |
| `--server-identity-file` | `AGENTPLEX_SERVER_IDENTITY_FILE` | none                  | Absolute; required for `server` and `both`                                                 |
| `--server-token`         | `AGENTPLEX_SERVER_TOKEN`         | minted on first start | Pairing token the deployment sets, 32+ chars; for a machine whose disk does not outlive it |
| `--data-path`            | `AGENTPLEX_DATA_PATH`            | `$HOME/.agentplex`    | Absolute; the one directory a server writes into                                           |
| `--bin-path`             | `AGENTPLEX_BIN_PATH`             | none                  | Agent directory, searched before `PATH`; repeatable                                        |
| `--tz`                   | `AGENTPLEX_TZ`                   | inherited             | Zone a spawned session reports times in; IANA name                                         |
| `--terminal-cap`         | `AGENTPLEX_TERMINAL_CAP`         | `8`                   | Terminals held at once; at least 1                                                         |
| `--drain-seconds`        | `AGENTPLEX_SERVER_DRAIN_SECONDS` | `15`                  | Seconds shutdown waits for turns to end                                                    |
| `--log-level`            | `AGENTPLEX_LOG_LEVEL`            | `info`                | `debug`, `info`, `warn`, `error`                                                           |

### Checking a machine

`agentplex doctor`, with the settings the daemons would take, reports what
that machine can actually start: per provider, the version, the directory it
resolved from and whether it is logged in; per store path, whether it is there.
It changes nothing and exits `1` when anything it looked at is unusable. The
same check runs at server startup and its result travels in the handshake, so a
provider that is missing or logged out is a named fact on the settings screen
and a refused start, rather than a session that appears and vanishes.

### Pairing a server with the hub

A server mints two durable facts into its identity file on first start: the
`serverId` it answers to, and the token that admits a hub. The file is not
logged, only its path — open it, copy the token, and type it into the hub along
with the server's `wss://` address. That is the only way a pairing is made;
discovery on the LAN pre-fills the address and nothing more.

Keep the identity file somewhere that survives a restart: a server that loses
it mints a new identity, and the pairing stops working until you pair again.

### Grants: what a server can take away

Beside the identity file, named after it, a server keeps a **grants file** —
`server.json` gets `server-grants.json`. One record per pairing: a label, a
verifier for the token, the hub id first seen presenting it, when it was created
and last used, an optional expiry, and whether it was revoked. That is the unit
an operator revokes, and revoking one leaves every other hub connected.

The token in the identity file is grant zero. Nothing about a fresh install
changes, no hub needs migrating, and on the first start of an upgraded server
the grants file appears holding that one record. Revoking grant zero is allowed
and does what it says: on a `--role=both` machine, the hub beside the server
stops connecting until you re-mint the identity file.

Three things are worth knowing about how it behaves.

**It holds a verifier, not a token.** The hub must keep its tokens in the clear
because it presents them; a server only ever checks one, so it stores a SHA-256
of it. Somebody who can read the grants file cannot pair with what they found.

**A revocation reaches a server that is already running.** The grants file is
re-read at every handshake, so a hub revoked while disconnected is refused the
moment it comes back, and a sweep on a short interval closes the connections a
revoked or expired grant is still holding. There is no restart in either path.

**A rejected handshake says only that it failed.** A revoked grant, an expired
one and a token nothing was ever minted for are all refused identically —
`unauthorized`, and no more. Telling a peer that its credential was real but
withdrawn is exactly the thing worth probing for. Which of the three it was is
in the server's log, where the person entitled to know it is.

The hub id a hub sends is a **label**. It is self-reported, so nothing is
decided with it; the server records the one it saw against the grant and, when
a later one disagrees, accepts the connection and says so in the log. A hub
whose database was rebuilt mints a new id and is still the same operator with
the same token.

Where there is no such place — a container whose filesystem goes at the next
deploy, a CI job nobody will ever shell into — the deployment can supply the
token instead, with `AGENTPLEX_SERVER_TOKEN`. The server writes that token into
the identity file rather than minting one, so the secret is known before the
process first starts and nobody has to read a file off the box to learn it. A
file that already holds a different token stops the start rather than either
token quietly winning: a server answering to a credential you believe you
replaced is the failure that would cause.

That settles the token and not the `serverId`, which is still minted per file.
A hub refuses a handshake presenting a different `serverId` than the pairing was
completed with, so a server whose filesystem is genuinely disposable wants its
identity file on a mounted volume as well.

The hub dials the server, never the reverse, so a server needs one inbound port
reachable by the hub and dials out to nothing. That port carries both the health
check and the hub's websocket. TLS is terminated in front of the process — the
bundled Caddy, an existing reverse proxy, or a Tailscale/WireGuard route — which
is why the hub refuses to dial anything but `wss://`.

A server holds at most `--terminal-cap` terminals. Reaching the cap closes the
one whose last watcher left longest ago, never one somebody is watching; the
session itself is untouched, because its transcript is on disk and resuming it
starts a new terminal. Nothing else closes a terminal — there is no idle timer,
and a session outlives the tab that opened it — except stopping the server.

A store is identified by an `agentplex-store.json` file at its root, minted the
first time a server mounts it. Two servers mounting the same volume report the
same store, and moving the volume takes its sessions with it.

Everything a server writes for itself goes under `--data-path`, one directory
per server, created at boot. A store path is a provider's directory and is only
read; the data root is the server's own, and a server that cannot create it or
cannot write in it refuses to start rather than losing what it was keeping
there. A store that is missing is reported and costs only itself.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
