# The three deployments

Two roles and one program give three shapes, and the design has to hold all
three: one machine, one network, several EC2 instances. Each is below, end to
end, from a box with nothing on it.

The thing that stays true across all three is what a session is named by. A
session is `{ storeId, sessionId }` — a store and a session inside it — and
never a machine. A volume that moves to another server keeps its sessions, and a
server rebuilt from an image is a new machine holding the same stores.

[install.md](install.md) has the bootstrap script's options, the full
configuration table, and the arguments behind the systemd unit. This document
assumes them.

> Status: the bootstrap, the units and the packaging are real today.
> `agentplexd setup` — the wizard and the plan replay it shares a code path with
> — is being built alongside this; where a step below runs `setup`, it says so.
> Every step that does not is available now.

## One machine

The common case, and the one that needs the least explaining: a Proxmox LXC, a
spare NUC, a mac mini under a desk. One process in `--role=both`, one SQLite
file, and the agents running as you against your own home directory.

On a fresh Debian container, as the user who will own the sessions — not as
root:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/agentplexd/packaging/install.sh | bash
```

That ensures Node and the C++ toolchain, installs `agentplexd` into
`~/.agentplex`, writes `~/.agentplex/agentplexd.env` and a systemd user unit,
and hands over to `agentplexd setup`.

Two things about the container itself, both of which bite before agentplex is
involved:

- **Create a user.** A Proxmox LXC from a stock template drops you at a root
  shell, and root is the one user this install refuses. `adduser <name>` and
  `su - <name>` first. The refusal is not fussiness — a server spawns coding
  agents with the operator's credentials and writes into their checkouts, and
  root-owned stores are tedious to reverse.
- **Enable lingering.** A systemd _user_ unit runs while its user has a session
  and stops when they log out, which on a headless container means the service
  dies with your SSH connection. `loginctl enable-linger <name>` is what makes
  it a service. Nothing else about the unit changes.

Setup mints the pairing token for the local server and writes both ends of it
itself, so nothing is typed. That is a deliberate, narrow exception to the rule
that pairing is always a person typing a token: the same operator, on the same
host, in one interactive run, for a server reached over the loopback. Making
somebody hand-pair their own box would be ceremony with no security value.

What is left is the client token, which is the credential between a phone and
every session on the machine. It has no default:

```sh
echo "AGENTPLEX_CLIENT_TOKEN=$(openssl rand -base64 32)" >> ~/.agentplex/agentplexd.env
systemctl --user daemon-reload
systemctl --user enable --now agentplexd
```

Then check the machine and open it:

```sh
~/.agentplex/bin/agentplexd doctor --role=both \
  --database-file="$HOME/.agentplex/hub.sqlite" \
  --server-identity-file="$HOME/.agentplex/server.json"
```

The hub serves the web app on its own port and origin, so there is no second
service to run. Web push needs a certificate a browser already trusts, which on
a private machine is what `tailscale serve --bg --https=443
http://127.0.0.1:8080` is for — see
[Dropping Caddy](install.md#dropping-caddy).

## One network

A hub box, and `--role=server` on every machine that should run sessions: the
gaming desktop with the GPU, the mac mini with the credentials on it, the LXC
that has the checkouts.

On the hub box:

```sh
curl -fsSL <url> | bash -s -- --role=hub
```

On each session machine:

```sh
curl -fsSL <url> | bash -s -- --role=server
```

The hub dials each server; a server dials out to nothing. So a server needs one
inbound port reachable from the hub — the same `--server-port` that answers
`/health` also carries the hub's websocket — and no outbound rule at all. TLS is
terminated in front of the process, which is why the address typed into the hub
is `wss://`: the pairing token travels on that socket.

### Pairing, with the address filled in for you

Pairing is the token out of a server's identity file, typed into the hub along
with the server's address. Discovery makes the address half of that stop being
something you look up.

A server announces itself only if it is told to:

```sh
# in the server's agentplexd.env
AGENTPLEX_ANNOUNCE=true
```

The hub's listener is unconditional — hearing a machine announce itself costs
nothing and grants nothing — and what it hears becomes a _candidate_: a claim
about right now, held in memory, aged out after six missed announcements, and
never written to the database. A pairing is durable because a person made it; a
beacon claim is a datagram, and a row that survived a restart would offer a
machine on the strength of one nobody heard.

On the settings screen a candidate pre-fills one line of the pairing form, the
address, and stops there. The token is still read off the server and typed:

```sh
cat ~/.agentplex/server.json    # {"serverId": "...", "token": "..."}
```

Candidates and paired servers are two separate lists in the client for a
structural reason rather than a visual one. A single list with a flag on it
would put a datagram from an unauthenticated stranger one boolean away from
being drawn as a machine of yours. Being heard on a network is nowhere near
being trusted by it: discovery is convenience, and trust is still the token.

Announcing is off by default because the deployment that benefits from it — a
home network where a person is looking at both machines — is not the deployment
that carries the risk, and a beacon that has to be asked for is one nobody
turned on by accident on a VPS.

## Several EC2 instances

The tier the plan file exists for. There is no person at the machine when it
boots, so nothing can be interactive, and every instance in a scaling group has
to come up describing the same thing.

`--role=server --no-setup --system` in user-data, plus a plan replayed as the
service account:

```sh
#!/bin/bash
set -euo pipefail

curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/agentplexd/packaging/install.sh \
  | bash -s -- --role=server --no-setup --system

aws ssm get-parameter --name /agentplex/plan --with-decryption \
  --query Parameter.Value --output text > /etc/agentplex/plan.json
chown agentplex:agentplex /etc/agentplex/plan.json
chmod 0600 /etc/agentplex/plan.json

sudo -u agentplex /opt/agentplex/bin/agentplexd setup --plan /etc/agentplex/plan.json
systemctl enable --now agentplexd
```

`--no-setup` is what makes that script work: it stops once the binary lands, for
exactly this machine — one that will be handed a plan rather than asked
questions. `--system` is the other half. It creates the `agentplex` service
account, installs into `/opt/agentplex`, and writes a system unit carrying
`User=agentplex`, because a fleet instance has no human user to install for. It
also never opens a wizard even where a terminal exists, for the same reason.

The plan itself is a file, and a version is the first thing in it:

```json
{
  "version": 1,
  "role": "server",
  "server": {
    "port": 8081,
    "storePaths": ["/srv/work"],
    "binPath": ["/opt/agentplex/bin"],
    "identityPath": "/var/lib/agentplex/server.json",
    "installPrefix": "/opt/agentplex",
    "pairingToken": "<32 or more characters from a CSPRNG>",
    "providers": [{ "provider": "claude", "version": null }]
  }
}
```

The pre-minted `pairingToken` is why this tier works: an instance whose token
was decided in advance is pairable the moment it boots, where one that mints its
own is a machine somebody has to reach into to read a file. It is the one secret
a plan carries. A plan carries no client token and no database file — those are
the hub's, they already arrive as configuration with no default, and a plan is a
file that lives in user-data, in an image, and in whatever bucket somebody
copied it to.

Two properties fall out of the plan being an artifact rather than a script:

- **Pin the providers.** `"version": null` means whatever the provider calls
  current, which is the right answer when you are writing the first plan and the
  wrong one when you are replaying it in a month. A pinned version is what makes
  a replay produce the machine the plan described.
- **Re-running reconciles.** Applying a plan asks what is already there before
  it does anything: a store that has an id keeps it, and an identity file that
  exists is never minted over — including when the plan's token disagrees with
  it. So the same user-data is safe on a reboot and safe in a baked image.

Bake the install into an AMI and user-data shrinks to fetching the plan and
running `setup --plan`. The install is the slow part — it compiles a native
addon — and it is also the part that is identical on every instance.

> Status: `agentplexd setup --plan` and the wizard are the tickets after this
> one. Today an instance can be brought to the point where the binary, the
> service account, the unit and the environment file are in place; the last line
> of the script above is what those tickets complete.

## Taking it off a machine

One prefix, one environment file, one unit, and — where the script installed one
— one Node:

```sh
systemctl --user disable --now agentplexd
rm -rf ~/.agentplex ~/.config/systemd/user/agentplexd.service
```

For a `--system` install: `/opt/agentplex`, `/etc/agentplex`,
`/etc/systemd/system/agentplexd.service`, and the `agentplex` account and its
`/var/lib/agentplex` home, which holds the server identity and is the one thing
worth reading before deleting.

Nothing is installed outside those paths, which is the point of the owned prefix
and the reason the script never edits a shell profile: what it did is what you
can list, and undoing it is `rm`.
