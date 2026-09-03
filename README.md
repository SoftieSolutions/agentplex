# agentplex

Watch and drive coding-agent sessions across machines, from a phone or a laptop.

agentplex runs your coding-agent sessions (Claude Code today; the provider seam
is first class) wherever they belong — a homelab box, a mac mini, an EC2
instance — and gives you one installable web app that sees all of them, tells
you which ones are waiting on you, and lets you answer from wherever you are.

> Status: early. Milestone 1 of the [v2 design](docs/specs/2026-09-01-agentplex-v2-design.md)
> — the scaffold, protocol package, service skeleton and database — is what
> exists so far. It does not yet run sessions.

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

Both roles are the same program, `agentplexd`, started with `--role=hub`,
`--role=server`, or `--role=both`. Running both in one process is the ordinary
single-machine case.

## Repository layout

```
apps/agentplexd/     the service: src/hub/, src/server/, src/shared/
apps/web/            the PWA
packages/protocol/   frame types and parsers, shared by both
docs/specs/          design documents
```

`packages/protocol` is a package because two apps share it, and neither app may
import the other. That boundary is enforced by lint, not by convention.

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

[docs/install.md](docs/install.md) covers all of it: every setting, the two
ways to drop Caddy, the bare-metal role, and upgrading.

For working on the code, Node 24 and pnpm 11:

```sh
pnpm install
pnpm build
pnpm check          # lint, typecheck, test
pnpm docker:check   # the same, in a container
```

## Configuration

Every setting has one flag and one environment variable; the flag wins.

| Flag              | Environment               | Default        | Meaning                                              |
| ----------------- | ------------------------- | -------------- | ---------------------------------------------------- |
| `--role`          | `AGENTPLEX_ROLE`          | none, required | `hub`, `server` or `both`                            |
| `--host`          | `AGENTPLEX_HOST`          | `0.0.0.0`      | Interface to bind                                    |
| `--hub-port`      | `AGENTPLEX_HUB_PORT`      | `8080`         | Port the hub serves on                               |
| `--server-port`   | `AGENTPLEX_SERVER_PORT`   | `8081`         | Port the hub dials                                   |
| `--database-file` | `AGENTPLEX_DATABASE_FILE` | none           | SQLite file, absolute; required for `hub` and `both` |
| `--store-path`    | `AGENTPLEX_STORE_PATH`    | none           | Store root; repeatable, absolute                     |
| `--bin-path`      | `AGENTPLEX_BIN_PATH`      | none           | Where to find agent binaries; repeatable, ordered    |
| `--terminal-cap`  | `AGENTPLEX_TERMINAL_CAP`  | `8`            | Terminals held at once; at least 1                   |
| `--log-level`     | `AGENTPLEX_LOG_LEVEL`     | `info`         | `debug`, `info`, `warn`, `error`                     |

A server holds at most `--terminal-cap` terminals. Reaching the cap closes the
one whose last watcher left longest ago, never one somebody is watching; the
session itself is untouched, because its transcript is on disk and resuming it
starts a new terminal. Nothing else closes a terminal — there is no idle timer,
and a session outlives the tab that opened it — except stopping the server.

A store is identified by an `agentplex-store.json` file at its root, minted the
first time a server mounts it. Two servers mounting the same volume report the
same store, and moving the volume takes its sessions with it.

[docs/install.md](docs/install.md) has these in full, along with the settings
the compose file reads.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
