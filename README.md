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
                          Postgres
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

Docker is the primary path. Requires only Docker with the Compose plugin.

```sh
cp .env.example .env   # set POSTGRES_PASSWORD
docker compose up -d   # Postgres, the hub, and Caddy in front of it
curl -k https://localhost/health
```

One image serves both roles; the role is a runtime choice, by environment
variable or flag. Caddy is there only to terminate TLS with a certificate that
renews itself, because web push is HTTPS-only — if TLS is already handled,
`docker compose up -d hub` starts Postgres and the hub and nothing else.

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
pnpm docker:check   # the same, in a container, against a real Postgres
```

## Configuration

Every setting has one flag and one environment variable; the flag wins.

| Flag             | Environment              | Default        | Meaning                                 |
| ---------------- | ------------------------ | -------------- | --------------------------------------- |
| `--role`         | `AGENTPLEX_ROLE`         | none, required | `hub`, `server` or `both`               |
| `--hub-port`     | `AGENTPLEX_HUB_PORT`     | `8080`         | Port the hub serves on                  |
| `--server-port`  | `AGENTPLEX_SERVER_PORT`  | `8081`         | Port the hub dials                      |
| `--database-url` | `AGENTPLEX_DATABASE_URL` | none           | Postgres; required for `hub` and `both` |
| `--log-level`    | `AGENTPLEX_LOG_LEVEL`    | `info`         | `debug`, `info`, `warn`, `error`        |

`AGENTPLEX_HOST` is the exception, environment only: an interface to bind is a
deployment fact rather than a choice. [docs/install.md](docs/install.md) has it
and the settings the compose file reads.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
