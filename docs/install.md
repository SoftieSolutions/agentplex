# Installing agentplex

Two roles, one program. The **hub** owns the database, serves the web app, and
is the only thing clients talk to; the **server** runs sessions on its own
machine. They are the same binary started with `--role=hub`, `--role=server` or
`--role=both`.

Docker is one way to run this, not the only one. The hub's database is
a SQLite file, so a container is packaging and process supervision rather than a
dependency you could not otherwise satisfy: it is the primary path for the
checks and the right way to run a hosted hub, and it is not the price
of entry for a single machine. One box can run `--role=both` natively, over one
file. The server role in particular is better off outside a container, and is
covered under [The server role, bare metal](#the-server-role-bare-metal).

> Status: milestone 1. The hub migrates its database, mints its identity and
> answers `/health`; it does not yet run sessions. Everything below is real
> today, and the parts that are not yet wired say so.

Three deployments follow from those two roles — one machine, one network,
several EC2 instances — and each is walked through end to end in
[deployments.md](deployments.md).

## The bootstrap script

On a machine that has nothing on it yet, this is the whole install:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/agentplexd/packaging/install.sh | bash
```

`--role=both` is the default; `bash -s --` passes options through:

```sh
curl -fsSL <url> | bash -s -- --role=server              # a session machine
curl -fsSL <url> | bash -s -- --role=hub                 # a hub box
curl -fsSL <url> | bash -s -- --role=server --no-setup   # takes a plan later
```

It ensures a Node runtime and the C++ toolchain, installs the `agentplexd`
package, writes an environment file and a systemd unit it does not start, and
hands over to `agentplexd setup`. It knows nothing about providers, stores or
databases — everything provider-specific lives in TypeScript beside the adapter
that knows the provider, so adding a provider is never an edit to a shell script
nobody tests.

| Option           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `--role=<role>`  | `hub`, `server` or `both`; pre-seeds setup (default `both`) |
| `--no-setup`     | stop once the binary lands                                  |
| `--system`       | install under a dedicated service account; needs root       |
| `--version=<v>`  | pin the `agentplexd` version                                |
| `--prefix=<dir>` | install somewhere other than the default prefix             |
| `--dry-run`      | print the plan and change nothing                           |
| `--print-unit`   | print the systemd unit it would write, and stop             |
| `--help`         | the same table                                              |

`--role` pre-seeds setup rather than replacing it. `--no-setup` is for a machine
that will receive a plan file from cloud-init or a configuration manager and run
`agentplexd setup --plan` itself, which is the EC2 tier in
[deployments.md](deployments.md).

### Download, read, execute

`curl | bash` is an acceptable happy path and an unacceptable only path. The
same script, read first:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/agentplexd/packaging/install.sh -o install.sh
less install.sh
bash install.sh --role=server
```

`bash install.sh --dry-run` goes one better: it resolves every decision the real
run would make — the prefix, the package spec, whether it will install a Node,
whether it will install a toolchain and with which package manager, where the
unit goes — prints them as a plan, and changes nothing.

### Where the script is served from

The URL above is one constant at the top of the script, and a test holds this
document and that constant together, so there is exactly one place to change.

Three constraints settle it: HTTPS, a path this project controls, and a version
in that path, so that a command written down today keeps fetching the bytes it
fetched today. A tag satisfies all three — it names an immutable tree, served
over TLS, from the repository the script lives in. A short alias in front of it
(`get.<domain>/v1/install.sh`) is the remaining piece, and it is pending a
registration rather than a decision.

Until that registration exists, no domain name appears here as a command to run.
Publishing `curl | bash` against a host nobody has registered is an invitation
for somebody else to register it, and the instruction would still look exactly
right on the day they did.

### Not as root

The script refuses to install as root, and the refusal is the point rather than
caution. A server spawns coding agents with your credentials, reads the provider
state directories in your home, and writes into your checkouts. Root-owned
stores and root-run agents are a bad outcome that is tedious to reverse, so the
default install is for the invoking user, into `~/.agentplex`, with a systemd
_user_ unit that runs as that user by construction.

`--system` is the other supported path, and it does not run anything as root
either: it creates an `agentplex` service account, installs into
`/opt/agentplex`, and writes a system unit carrying `User=agentplex`. It is for
the fleet case — an image, a scaling group — where there is no human user to be.
It also never opens a wizard, because there is nobody at that machine to answer
one; a `--system` install takes a plan file, replayed as the service account.

The prefix is not put on your `PATH` for you. The script prints the one line to
add, and nothing that matters depends on your having added it: the unit's
`ExecStart` is an absolute path, and the directories a session resolves agent
binaries from are recorded as configuration rather than inherited.

### The systemd unit

The unit is written and deliberately not enabled. Nothing can start until the
environment file has a role, a database file, a client token or an identity file
in it, and a unit enabled before then would produce a restart loop rather than a
service.

```sh
systemctl --user daemon-reload
systemctl --user enable --now agentplexd
loginctl enable-linger "$USER"   # so it survives you logging out
```

For a `--system` install, the same two commands without `--user`.

Four decisions inside it are worth knowing, and `--print-unit` shows the whole
thing without installing anything:

- **`Environment=PATH=` starts with the prefix**, and carries the directory of
  the Node the install settled on when that is somewhere a service would never
  look. A systemd unit gets a minimal `PATH` with no homebrew, no
  `~/.local/bin` and no version-manager shims, which is the failure this whole
  design opens with — and it applies to the runtime too, because `agentplexd`
  is a script whose first line is `#!/usr/bin/env node`. In front of the rest of
  the machine rather than instead of it: a session is not only the agent, it
  shells out to `git`, `rg` and whatever else the project needs.
- **`RestartPreventExitStatus=2`.** Exit 2 is agentplexd saying its
  configuration is wrong. Restarting will not help and somebody has to act, so
  the unit stops instead of hiding that message inside a restart loop.
- **`EnvironmentFile=`, and the file is written once.** Everything in it is a
  decision somebody made, by hand or through `agentplexd setup`, so re-running
  the installer leaves an existing one exactly as it is. The same goes for the
  unit: an existing unit is left alone, and `--print-unit` is how you diff it
  against what this version would have written.
- **No sandboxing at all** — no `ProtectHome`, no `ProtectSystem=strict`, no
  `NoNewPrivileges`. This service's job is to run a developer's own tooling as
  that developer, against their home directory and their checkouts. Every one of
  those directives turns that job into a failure that reads like a bug in the
  agent. The isolation that matters here is the account the service runs as.

The script writes two settings into the environment file and no others: the role
you asked for, and `AGENTPLEX_BIN_PATH` pointing at the prefix it just created.
Both are facts the installer had. A database path or a store path is not, and a
guessed value is worse than an absent one.

## Installing the package

What the bootstrap script does, by hand. Reach for this when the machine already
has Node and a toolchain, or when you would rather run the three steps yourself
than read a shell script.

```sh
npm install --global agentplexd
```

That is the whole of it on a machine that has Node. The package carries the
compiled service, the compiled protocol, the built web app and the migrations,
so nothing here needs pnpm, vite or a checkout of this repository, and an
upgrade is an install of a later version. Pin one with `agentplexd@<version>`.

The package is laid out the way this repository is — `apps/agentplexd/dist`,
`apps/agentplexd/migrations`, `apps/web/dist` — because the service resolves its
migrations and the client it serves relative to its own file, and keeping that
layout is what makes those two expressions correct from a checkout, inside the
image and after an install alike.

### It needs a C++ toolchain on Linux

This is the one thing most likely to stop a clean install, so it is first.

Driving an agent through a real pseudoterminal means
[node-pty](https://github.com/microsoft/node-pty), a native addon that ships
prebuilt binaries for macOS and Windows only. On Linux npm compiles it at
install time and node-gyp needs `python3`, `make` and a C++ compiler. On a stock
`debian:bookworm-slim` none of them are there, and the install fails inside
node-gyp with an error that mentions neither agentplex nor a compiler.

```sh
sudo apt-get install --no-install-recommends --yes python3 make g++   # Debian, Ubuntu
sudo dnf install --assumeyes python3 make gcc-c++                     # Fedora, RHEL
```

The alternative — shipping prebuilt binaries in this package — was considered
and does not work: they would have to be placed inside node-pty's own directory
by a script of ours that runs _after_ node-pty's install script has already
failed, and under exactly the npm settings that disable install scripts in the
first place. So the toolchain is a prerequisite, `install.sh` installs it on the
Linux path, and CI installs this package on a bare Debian container every run so
that the claim keeps being tested rather than remembered.

### If your npm is configured to skip install scripts

node-pty's install scripts are what compile the addon, and agentplexd's own
`postinstall` restores the executable bit the npm tarball drops from node-pty's
`spawn-helper` — without which the first session fails with
`Error: posix_spawnp failed.` and nothing else. An npmrc carrying
`ignore-scripts=true` produces an install that reports success and a service
that cannot start, so override it for this package:

```sh
npm install --global --ignore-scripts=false agentplexd
```

Recent npm versions have a second, narrower gate and warn that these scripts are
"not yet covered by allowScripts". They still run today. To allow them
explicitly:

```sh
npm install --global --allow-scripts=node-pty,agentplexd agentplexd
```

`agentplexd doctor` is the fastest way to tell whether any of this worked: the
process loads node-pty on its way to printing a report, so a report is proof
that the addon compiled and can be loaded.

### Building the package from a checkout

```sh
pnpm package        # builds the workspace, then stages apps/agentplexd/release
pnpm docker:install # packs that tree and installs it on a bare Debian
```

`pnpm package` writes the exact tree that gets published and nothing else;
publishing is a separate, deliberate command aimed at that directory. It refuses
to stage a workspace whose client or protocol was never built, and refuses a
compiled entrypoint with no `#!` line, rather than producing a package that
installs and then cannot start. `pnpm docker:install` is the check CI runs.

## Compose quickstart

Requires Docker with the Compose plugin. Nothing else — not Node, not pnpm.

```sh
git clone https://github.com/SoftieSolutions/agentplex.git
cd agentplex
cp .env.example .env
echo "AGENTPLEX_CLIENT_TOKEN=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

One setting in `.env` has no default and has to be filled in: the client token,
which is what you type on a phone or a laptop to reach this hub. Compose refuses
to start without it rather than bringing up a hub anyone can attach to, and the
hub refuses a token shorter than 32 characters for the same reason. Everything
else in `.env` has a default that works on `localhost`.

That builds one `agentplexd` image and starts two containers: the hub, and Caddy
in front of it. The hub creates and migrates its database — one SQLite file in
the `hub-data` volume — before it listens, so there is no second service to come
up first and nothing to wait for.

```sh
curl -k https://localhost/health
# {"status":"ok","role":"hub","protocolVersion":2}
```

Then open `https://localhost` in a browser. The hub serves the web app itself,
on the same port and the same origin as everything else it answers — see
[What the hub serves](#what-the-hub-serves).

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

| Flag                     | Environment                      | Default        | Meaning                                                                               |
| ------------------------ | -------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `--role`                 | `AGENTPLEX_ROLE`                 | none, required | `hub`, `server` or `both`                                                             |
| `--host`                 | `AGENTPLEX_HOST`                 | `0.0.0.0`      | Interface to bind                                                                     |
| `--hub-port`             | `AGENTPLEX_HUB_PORT`             | `8080`         | Port the hub serves on                                                                |
| `--server-port`          | `AGENTPLEX_SERVER_PORT`          | `8081`         | Port the hub dials                                                                    |
| `--database-file`        | `AGENTPLEX_DATABASE_FILE`        | none           | SQLite file, absolute; required for `hub`, `both`                                     |
| `--client-token`         | `AGENTPLEX_CLIENT_TOKEN`         | none           | What a client presents to the hub, at least 32 characters; required for `hub`, `both` |
| `--store-path`           | `AGENTPLEX_STORE_PATH`           | none           | A store root, absolute; repeat the flag per store                                     |
| `--server-identity-file` | `AGENTPLEX_SERVER_IDENTITY_FILE` | none           | Absolute path to this server's identity; required for `server`, `both`                |
| `--bin-path`             | `AGENTPLEX_BIN_PATH`             | none           | A directory to resolve agent binaries in, absolute; repeat the flag per directory     |
| `--terminal-cap`         | `AGENTPLEX_TERMINAL_CAP`         | `8`            | How many terminals one server keeps open at once                                      |
| `--announce`             | `AGENTPLEX_ANNOUNCE`             | `false`        | `true` to broadcast a LAN beacon saying where this server is                          |
| `--log-level`            | `AGENTPLEX_LOG_LEVEL`            | `info`         | `debug`, `info`, `warn`, `error`                                                      |

A container is reached from outside its own loopback, so `0.0.0.0` is the
default that suits one; on a laptop, `--host=127.0.0.1` is often what you want.

`--store-path` and `--bin-path` are the two repeatable settings, because a
server may have more than one volume mounted and may find its agents in more
than one directory. On the environment side each list is separated the way
`PATH` is (`/volumes/one:/volumes/two`), since a container is configured with
environment and nothing else. A relative path is refused rather than resolved
against whatever directory the process was left in.

`--bin-path` decides where a spawned coding agent is looked for. With it set,
those directories go in front of the `PATH` agentplexd inherited, so they are
searched first and the rest of the machine stays reachable behind them; left
unset, the child inherits that `PATH` unchanged, which is what it always did.
It takes directories rather than binaries, so the agent is still spawned by its
bare name and a path can never appear where a program name belongs.

In front of rather than instead of, deliberately. The directories you record
are the ones that decide which `claude` runs, which is the point. But a session
is not only the agent: it shells out to `git`, `rg` and whatever else your
project needs, and agentplexd itself spawns `git` and `ps` for the status it
reports. A `PATH` holding only the agent's own directory would take all of that
away.

Set it when agentplexd runs as a service. A systemd unit gets a minimal `PATH`
with no homebrew, no `~/.local/bin` and no version-manager shims, so a `claude`
that resolves in your shell does not resolve in the unit, and the session fails
at spawn time with nothing pointing at the cause. `command -v claude` in the
shell you installed it from names the directory to list here.

## Checking a machine: `agentplexd doctor`

```sh
agentplexd doctor --role=server --server-identity-file=... --store-path=...
```

`doctor` takes the same configuration the service takes and reports what that
configuration can actually start: per provider, the version, the directory it
resolved from and whether it says it is logged in; per store path, whether it is
there. It changes nothing — it binds no port, opens no database, and does not
mint the store file a first real start would. It exits `0` when everything it
looked at is usable and `1` when anything is not, so it can be a check in a
script; the report goes to stdout and its own log lines to stderr.

```
agentplexd doctor  role=server

providers
  claude     ready            2.1.259      /home/robert/.local/bin

stores
  present    /home/robert/code
  missing    /mnt/volumes/universe
    there is nothing at that path
```

"Which directory did this come from" is the question to ask when the wrong
version runs, and until a session has started there is nowhere else it can be
answered. The same resolution runs at server startup, and its result travels in
the handshake, so the hub knows what each machine can start: a provider that is
missing or logged out is named on the settings screen and a start aimed at that
machine is refused with that reason, instead of a session that appears and
immediately vanishes. That last shape is not a bug that could be fixed later —
on a pty the fork succeeds and the program is resolved on the far side of it, so
there is nothing to report at spawn time.

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
| `AGENTPLEX_HUB_BIND` | `127.0.0.1` | Host address the hub's plain HTTP port is published on       |

`AGENTPLEX_HUB_BIND` is the one to think about. Loopback is right whenever
something on this machine terminates TLS — Caddy, `tailscale serve`, a reverse
proxy — because in every one of those cases the hub's plain HTTP port has no
business being reachable from the network. Widening it to `0.0.0.0` serves
unencrypted HTTP to anyone who can route to the host.

## What the hub serves

One port, one origin, four things: the web app, the client websocket, the MCP
endpoint and web push. They are not separable. MCP is same-origin and
token-authed, and same-origin is a claim about where the UI came from — it means
something only because the hub is what served it.

So the hub serves the built PWA off its own disk, from `apps/web/dist` beside
the service's own build. The image ships that directory; a workspace build puts
it there; `pnpm build` is what produces it on bare metal. Nothing else needs to
be running, and there is no separate web server to configure.

Two rules about caching, because they are the ones that bite later:

- Everything under `/assets/` is fingerprinted by the build and is served
  `immutable` for a year.
- The shell, the service worker, the manifest and the icons are served
  `no-cache`, which means "cache it and revalidate every time" rather than "do
  not cache it". A cached shell names the bundle of the build that was deployed
  when the browser cached it, and no later deploy can reach it.

A path with no file behind it and no extension — `/settings`, say — is a screen
the app routes to, and gets the shell. A path with an extension gets a 404 if
it is not there, because answering a missing `index-abc123.js` with HTML turns a
half-copied build into a syntax error in the browser console.

A hub with no build beside it says so: it starts anyway, logs
`no client build to serve` with the directory it looked in, and answers 503 to
a browser rather than a 404 that would claim the page does not exist or a 500
that would claim a fault. The database, the paired servers and `/health` are
all unaffected — a missing directory is not a reason to take a fleet down.

To develop against a running hub, `pnpm --filter @agentplex/web dev` serves the
app on port 5173 and proxies `/client` and `/health` to `http://127.0.0.1:8080`,
so the one-origin arrangement above holds in dev too.

## Reaching the hub from a device

`AGENTPLEX_CLIENT_TOKEN` is the whole of it. One token for the hub rather than
one per device, typed on each device that should reach it, and changing it is
how you revoke every device at once.

The token is never put in a URL. A `WebSocket` constructor cannot set a header,
so a socket is opened with a ticket instead: the device presents the token to an
ordinary request, gets a ticket good for one use and ten seconds, and spends it
opening the socket.

```sh
TICKET=$(curl -sk -X POST https://localhost/client/ticket \
  -H "authorization: Bearer $AGENTPLEX_CLIENT_TOKEN" | jq -r .ticket)
websocat -k "wss://localhost/client?ticket=$TICKET"
```

A wrong token is a `401`. A ticket that was already spent, or issued more than
ten seconds ago, closes the socket with `1008`. Both mean the same thing and say
the same thing — `not authorized` — and neither says which of the two it was.

## Pairing a server with the hub

> The server half of this is wired today: a server mints its identity, listens,
> and completes the handshake. The hub side is the connection supervisor and the
> pairing screen, which arrive with the client; until then there is nothing to
> type the token into.

`--server-identity-file` is where a server keeps the two facts it must not lose
across a restart: the `serverId` the hub knows it by, and the token that admits
a hub. Both are minted on first start, into a file the server creates and never
overwrites. Point it somewhere durable — a bind-mounted path in a container, a
real path under `/etc` or the user's home on bare metal. A relative path is
refused, because it would resolve against whatever directory the process was
left in, and a server that reads a different file mints a second identity and
silently stops matching the pairing you made.

Pairing is the token out of that file, typed into the hub with the server's
address:

```sh
cat /etc/agentplexd/server.json    # {"serverId": "...", "token": "..."}
```

The token is never logged; the server logs only the path, because a secret in a
log file is one that has to be rotated. Pairing is always this — the user typing
that server's token into the hub. LAN discovery pre-fills the address and
nothing else: being heard on a network is nowhere near being trusted by it. See
[One network](deployments.md#one-network) for how a server is heard at all.

Tokens are per server, so revoking one instance touches no other. If a server
loses its identity file it comes back as a machine the hub has never met, and
you pair it again.

The hub dials the server; a server dials out to nothing. So a server needs one
inbound port reachable by the hub — the same `--server-port` that answers
`/health` also carries the hub's websocket — and no outbound rule at all. TLS is
terminated in front of the process (the bundled Caddy, an existing reverse
proxy, or a Tailscale/WireGuard route), which is why the address you type must
be `wss://`: the token travels on that socket.

The hub and the server must speak the same protocol version, compared exactly.
A mismatch is refused at the handshake and named, rather than becoming a
connection where neither end knows which fields the other understood.

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
docker compose up -d hub     # The hub alone. Caddy is never started.
```

Compose starts a named service and the services it depends on, and nothing
else. The hub depends on nothing, so that one command is the whole of it.

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

Requires Node 24 and, on Linux, the toolchain under
[Installing the package](#installing-the-package). It does not require pnpm or a
checkout.

```sh
npm install --global agentplexd
mkdir -p ~/.agentplexd
agentplexd \
  --role=server \
  --server-port=8081 \
  --server-identity-file="$HOME/.agentplexd/server.json"
```

From a checkout instead, `pnpm install && pnpm build` and then
`node apps/agentplexd/dist/main.js` with the same flags: it is the same file the
package installs, at the same path inside it.

It holds no database. The identity file is the one piece of state it keeps, and
it has to outlive a restart: the first start mints the `serverId` and the
pairing token into it, and every later start reads them back. See
[Pairing a server with the hub](#pairing-a-server-with-the-hub).

It dials out to nothing; the hub dials it, so the one requirement is that the
hub can reach that port — over a LAN, a tailnet, a VPN, or an SSH tunnel. How
the route exists is deployment, not protocol. The hub dials `wss://`, so
whatever terminates TLS in front of the process is part of that route.

To keep it running across reboots, hand it to whatever the machine already
uses: `launchd` on macOS, a systemd user unit on Linux. Both stop a service
with `SIGTERM`, which is the signal the process already shuts down cleanly on.

The same applies to the hub if you would rather not run Docker at all: point
`--database-file` at a file on a disk you back up, set `AGENTPLEX_CLIENT_TOKEN`,
and run `--role=hub`, or
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

The compose file at `docker-compose.test.yml` runs the checks in a container:

```sh
pnpm docker:check   # lint, typecheck and test
pnpm docker:test    # tests only
```

There is no database service in it, and no check needs one: the migration suite
opens a SQLite file in a temporary directory, so it runs the same way there, in
CI, and under a plain `pnpm test` on a laptop with no Docker at all. What that
file is still for is sameness — every check runs against the same built tree in
the same image, so a green run there is the evidence CI produces rather than an
approximation of it.

Two checks are about the bootstrap rather than about this tree:

```sh
pnpm lint:shell     # shellcheck over install.sh
pnpm docker:bootstrap
```

`pnpm lint:shell` is not part of `pnpm lint`, because the image the checks run
in has no shellcheck in it and adding one to a Node image to lint one file is a
worse trade than a second command. CI runs it on the runner, which ships one.

`pnpm docker:bootstrap` is the acceptance criterion for the script: a stock
`debian:bookworm-slim` with no Node, no compiler and no agentplexd, three
packages added to model the machine a person actually has, and then `install.sh`
run as an unprivileged user with `agentplexd doctor` at the end of it.
