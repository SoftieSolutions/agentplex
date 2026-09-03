# Installing agentplex

Two roles, one program. The **hub** owns the database, serves the web app, and
is the only thing clients talk to; the **server** runs sessions on its own
machine. They are the same binary started with `--role=hub`, `--role=server` or
`--role=both`.

The hub belongs in a container: it is a network service with one dependency and
no business touching the host. The server role is the opposite case and is
covered under [The server role, bare metal](#the-server-role-bare-metal).

> Status: milestone 1. The hub migrates its database, mints its identity and
> answers `/health`; it does not yet run sessions. Everything below is real
> today, and the parts that are not yet wired say so.

## Compose quickstart

Requires Docker with the Compose plugin. Nothing else — not Node, not pnpm.

```sh
git clone https://github.com/SoftieSolutions/agentplex.git
cd agentplex
cp .env.example .env
$EDITOR .env          # at minimum, set POSTGRES_PASSWORD
docker compose up -d
```

That builds one `agentplexd` image and starts three containers: Postgres, the
hub, and Caddy in front of it. Postgres comes up first and the hub waits for it
to accept connections, because the hub migrates the schema before it listens.

```sh
curl -k https://localhost/health
# {"status":"ok","role":"hub","protocolVersion":2}
```

`docker compose logs -f hub` follows the hub. `docker compose down` stops
everything and keeps the database; `docker compose down -v` deletes it.

With `AGENTPLEX_DOMAIN=localhost`, Caddy signs its own certificate, which is
why `curl` needs `-k`. That is enough to see the stack work and not enough to
run it: web push requires a certificate a browser already trusts. Point
`AGENTPLEX_DOMAIN` at a public name that resolves to this machine, open ports
80 and 443 to the internet, and Caddy gets a real one from Let's Encrypt on
first request and renews it from then on.

## Configuration

Every setting the process reads has one flag and one environment variable, and
the flag wins, because a flag is typed by a person at the moment they mean it
and an environment variable is inherited.

| Flag              | Environment               | Default        | Meaning                                           |
| ----------------- | ------------------------- | -------------- | ------------------------------------------------- |
| `--role`          | `AGENTPLEX_ROLE`          | none, required | `hub`, `server` or `both`                         |
| `--host`          | `AGENTPLEX_HOST`          | `0.0.0.0`      | Interface to bind                                 |
| `--hub-port`      | `AGENTPLEX_HUB_PORT`      | `8080`         | Port the hub serves on                            |
| `--server-port`   | `AGENTPLEX_SERVER_PORT`   | `8081`         | Port the hub dials                                |
| `--database-file` | `AGENTPLEX_DATABASE_FILE` | none           | SQLite file, absolute; required for `hub`, `both` |
| `--store-path`    | `AGENTPLEX_STORE_PATH`    | none           | A store root, absolute; repeat the flag per store |
| `--log-level`     | `AGENTPLEX_LOG_LEVEL`     | `info`         | `debug`, `info`, `warn`, `error`                  |

A container is reached from outside its own loopback, so `0.0.0.0` is the
default that suits one; on a laptop, `--host=127.0.0.1` is often what you want.

`--store-path` is the one repeatable setting, because a server may have more
than one volume mounted. On the environment side that list is separated the way
`PATH` is (`/volumes/one:/volumes/two`), since a container is configured with
environment and nothing else. A relative path is refused rather than resolved
against whatever directory the process was left in.

The first time a server mounts a store it writes `agentplex-store.json` at that
root, containing the id every session in that store is scoped by. The file is
the store's identity: two servers mounting the same volume report the same
store, and a volume that moves keeps its sessions. A store whose file cannot be
read or parsed is reported as unavailable and skipped — the server still starts
and still serves the stores it can read, and it never mints a second identity
over a file it did not understand.

An unknown flag stops the process rather than being ignored: starting with the
wrong database because `--databse-file` was silently dropped is worse than not
starting.

The compose file reads a few more of its own from `.env`, none of which the
process itself sees:

| Variable             | Default     | Meaning                                                      |
| -------------------- | ----------- | ------------------------------------------------------------ |
| `AGENTPLEX_DOMAIN`   | `localhost` | The hostname Caddy answers on and requests a certificate for |
| `POSTGRES_USER`      | `agentplex` | Database role, used by the container and the hub's URL       |
| `POSTGRES_PASSWORD`  | none        | Required. Interpolated into a URL, so keep it alphanumeric   |
| `POSTGRES_DB`        | `agentplex` | Database name                                                |
| `AGENTPLEX_HUB_BIND` | `127.0.0.1` | Host address the hub's plain HTTP port is published on       |

`AGENTPLEX_HUB_BIND` is the one to think about. Loopback is right whenever
something on this machine terminates TLS — Caddy, `tailscale serve`, a reverse
proxy — because in every one of those cases the hub's plain HTTP port has no
business being reachable from the network. Widening it to `0.0.0.0` serves
unencrypted HTTP to anyone who can route to the host.

## The image

One image, both roles, chosen at runtime:

```sh
docker run --rm -e AGENTPLEX_ROLE=server -p 8081:8081 agentplexd
docker run --rm -p 8081:8081 agentplexd --role=server
```

Either works — anything after the image name lands as flags. The container's
health check reads `AGENTPLEX_ROLE`, `AGENTPLEX_HUB_PORT` and
`AGENTPLEX_SERVER_PORT` to decide which ports to probe, so a container that
picks its role with a flag alone will have its health measured on the hub's
port. Set the environment variable too, or override `HEALTHCHECK`.

The process runs as the unprivileged `node` user and is pid 1, so Docker's
`SIGTERM` reaches its shutdown handler directly and `docker stop` returns in
well under a second rather than timing out after ten.

## Dropping Caddy

Caddy is in the compose file for exactly one reason: web push is HTTPS-only, so
the hub needs a certificate that issues and renews itself. If TLS is already
handled in front of this machine, Caddy is a second thing doing the same job
and should go.

Both routes below leave the hub published on `AGENTPLEX_HUB_BIND:8080`, which
is where your existing terminator forwards to. Neither needs the compose file
edited, though deleting the `caddy` service and the `Caddyfile` is a reasonable
thing to do once you know you will not want them back.

```sh
docker compose up -d hub     # Postgres and the hub. Caddy is never started.
```

Compose starts a named service and the services it depends on, and nothing
else, so that one command is the whole of it.

### Tailscale HTTPS

Tailscale issues a certificate for your tailnet name and terminates TLS itself.
Leave `AGENTPLEX_HUB_BIND=127.0.0.1`, then on the host:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

The hub is then at `https://<machine>.<tailnet>.ts.net`, with a certificate
browsers trust, reachable only by devices on the tailnet. This is the smallest
correct deployment: no ports open to the internet, no DNS to manage, and web
push works because the origin is genuinely secure.

### An existing reverse proxy

If nginx, Traefik or another Caddy already fronts this machine, point it at
`127.0.0.1:8080` and leave `AGENTPLEX_HUB_BIND` on loopback. The one thing the
proxy must do beyond forwarding is pass websocket upgrades through: the client
connection and the hub's connection to each paired server are both websockets,
and a proxy that answers `Upgrade` with a 200 will look like a hub that accepts
connections and never says anything.

## The server role, bare metal

Running the server role directly on the operating system, with no container, is
an equally supported path and often the better one.

The reason is what the role does. A server spawns coding-agent sessions in PTYs
against the machine's real filesystem and the credentials sitting in the user's
home directory: the provider CLI's own login, an SSH agent, a keychain, the
checkouts the sessions edit. In a container each of those becomes a mount or a
forwarded socket, and the reward for that work is isolation from a machine the
sessions are supposed to be driving. On a personal mac mini or laptop, outside
a container is the honest arrangement.

Requires Node 24 and pnpm 11.

```sh
git clone https://github.com/SoftieSolutions/agentplex.git
cd agentplex
pnpm install
pnpm build
node apps/agentplexd/dist/main.js --role=server --server-port=8081
```

It holds no database and needs no configuration beyond its port. It dials out
to nothing; the hub dials it, so the one requirement is that the hub can reach
that port — over a LAN, a tailnet, a VPN, or an SSH tunnel. How the route
exists is deployment, not protocol.

To keep it running across reboots, hand it to whatever the machine already
uses: `launchd` on macOS, a systemd user unit on Linux. Both stop a service
with `SIGTERM`, which is the signal the process already shuts down cleanly on.

The same applies to the hub if you would rather not run Docker at all: point
`--database-file` at a file on a disk you back up and run `--role=hub`, or
`--role=both` to have one process do both jobs on one machine, which is the
ordinary single-machine case.

## Upgrading

```sh
git pull
docker compose up -d --build
```

The hub applies any new migrations on start, before it listens. Migrations are
forward-only: there is no `down`, and a database that has run a migration the
running build does not ship refuses to open rather than serving from a schema
it cannot explain. That is what a downgrade looks like from the inside, and it
is deliberate — check out the newer tag again rather than trying to force it.

Certificates and the ACME account key live in the `caddy-data` volume. Keep it
across upgrades; losing it means asking a certificate authority for everything
again, which is how a deployment meets a rate limit.

## Checks

The compose file at `docker-compose.test.yml` runs the checks in a container
against a real Postgres:

```sh
pnpm docker:check   # lint, typecheck and test
pnpm docker:test    # tests only
```

The database is why that file exists. The migration suite runs its SQL against
a real server, and the test compose file supplies one through
`AGENTPLEX_TEST_DATABASE_URL`. Without that variable the suite starts a
throwaway Postgres container of its own through testcontainers, so `pnpm test`
on a laptop with a Docker daemon runs the same tests; with no daemon either, it
skips itself and says so on stderr rather than passing quietly. When you are
done, `docker compose -f docker-compose.test.yml down -v` removes the
throwaway database, which is otherwise left running for the next run to reuse.
