# Install and provisioning

How agentplex gets onto a machine, how the coding-agent CLIs it drives get
there, and how the server finds them afterwards.

Depends on `2026-09-03-sqlite-hub-storage-design.md`. Without it the hub needs
Postgres, a one-box install needs Docker, and most of this document is not worth
building.

Status: proposed, 2026-09-03. Nothing here is built.

## The problem

Two problems that look separate and are not.

**The server cannot reliably find the binaries it spawns.** `CLAUDE_COMMAND` is
the bare name `claude`, resolved against whatever PATH `agentplexd` inherited.
Under systemd -- which is how anything on a Proxmox LXC or an EC2 instance will
actually run -- that PATH is minimal: no homebrew, no `~/.local/bin`, no version
manager shims. The binary that resolves in the operator's shell does not resolve
in the service, and the failure surfaces as `ENOENT` at spawn time, reported as
"the machine said no", with nothing pointing at the cause. It bites silently,
which is the class of problem this repository takes seriously.

**There is no installation.** `docs/install.md` offers `git clone` plus Docker
Compose. That is a way to run the hub; it is not a way to put agentplex on a
machine, and it has nothing to say about the coding agents, which are the entire
point of the product. A user with a spare LXC has no path that ends in a working
system.

## Shape

```sh
curl -fsSL https://<domain>/install.sh | bash                      # role=both, then setup
curl -fsSL https://<domain>/install.sh | bash -s -- --role=server  # server only
curl -fsSL https://<domain>/install.sh | bash -s -- --role=hub     # hub only
curl -fsSL https://<domain>/install.sh | bash -s -- --role=server --no-setup
```

`install.sh` is deliberately ignorant. It ensures a Node runtime and the build
toolchain, installs the `agentplexd` package, and executes `agentplexd setup`.
It knows nothing about providers, stores or databases: everything
provider-specific lives in TypeScript beside the adapter that knows the
provider, so a new provider is a new file rather than an edit to a shell script
that nobody tests.

`--role` pre-seeds the wizard rather than replacing it. `--no-setup` stops after
the binary lands, for machines that will receive a plan file from cloud-init or
a configuration manager and run `agentplexd setup --plan` themselves.

The script must be served over HTTPS from a domain the project controls, must be
versioned, and the documentation must also show the download-read-execute form.
`curl | bash` is an acceptable happy path and an unacceptable only path.

## The three deployments, and why the design has to hold all of them

**One machine.** The common case. `--role=both`: one process, one SQLite file,
the agents running as the operator against their own home directory. Setup mints
the pairing token and writes both ends itself; no token is ever typed.

**One network.** A hub box, and `--role=server` on the other machines. The
beacon in `2026-09-01` (opt-in UDP announce, listener unconditional) makes a new
server appear as a candidate that pre-fills the pairing form, so pairing is an
address confirmed rather than typed. Discovery is convenience; trust is still
the token.

**Several EC2 instances.** `--role=server --no-setup`, plus a plan file in
user-data or baked into an image. The plan may carry a pre-minted token so the
instance is pairable the moment it boots. This tier is the entire reason the
wizard produces a replayable artifact instead of merely mutating a machine.

## `agentplexd setup`

A terminal wizard, because most of what it needs to know it can discover and
offer -- which stores exist, which providers are already installed and logged
in, which roles make sense here -- and a flag wall would make the operator type
answers the machine already has.

The wizard is not the setup. It is one front end that produces a `SetupPlan`,
and provisioning consumes the plan. `agentplexd setup` is interactive;
`agentplexd setup --plan <file>` replays; the wizard's last screen offers to
save. One code path, two front ends, and the plan goes through a parser that can
say no exactly like every other value that arrives from outside.

Re-running reconciles rather than duplicates. `agentplexd doctor` is the
read-only half: per provider, the version, the directory it resolved from, and
its authentication state; per store, whether the path exists.

## Where providers come from, and where they are found

This is the question the whole document exists to answer, and the answer is a
list of directories.

Setup resolves each provider once. If the provider is already present on the
operator's PATH -- installed by homebrew, by npm, by a version manager -- setup
**adopts it** and records the directory it was found in. Only when nothing is
found does setup install into a prefix agentplex owns, `~/.agentplex/bin`, and
record that.

Adoption is not a nicety. An operator's existing `claude` is the one they have
authenticated. Installing a second copy into an owned prefix and putting it
first on PATH would shadow a working, logged-in binary with a fresh one that is
not, and the resulting failure would present as an authentication bug with no
visible cause.

The recorded directories become `binPath` on `ServerConfig`, and the server
builds the child PATH from exactly those rather than from what it inherited.
Four properties fall out at once:

- **Deterministic.** systemd's minimal PATH stops mattering, which removes the
  silent `ENOENT` this document opened with.
- **Adoptive.** The binary the operator authenticated is the binary that runs.
- **Bare names survive.** `file` and `command` stay program names, so the
  operation registry's assertion that `file` matches `/^[a-z][a-z0-9-]*$/`, and
  the rule that a path can never appear where a program name belongs, are
  untouched. Recording a directory list is what makes controlling resolution
  compatible with refusing paths.
- **Auditable.** `doctor` can say which directory each provider came from,
  which is the question an operator actually asks when the wrong version runs.

The case this does not fully cover is a version-manager shim that needs its own
environment to function. The version probe at setup time discovers that then,
where a person is present to act on it, rather than at first spawn.

## Provisioning on the provider seam

Installation, version probing, authentication state and login are
provider-specific, so they live where everything provider-specific lives.
Adapters return plans and execute nothing, exactly as `spawn` and `resume` do,
and use the same ok-or-refusal `Launch` shape:

```ts
readonly provisioning: ProviderProvisioning;

interface ProviderProvisioning {
  install(request: InstallRequest): InstallPlan;  // one-shot argv into a prefix
  version(): VersionProbe;                        // argv, and how to read stdout
  authState(): AuthProbe;                         // logged in, or not
  login(): Launch;                                // a pty launch
}
```

`authState` reads the provider's own state directory and never writes to it.
The v1 rule -- never write into a provider's state directory -- is what keeps
adapters from rotting every time a provider changes its on-disk format, and
setup planting credential files would break it on day one.

## A second registry, not a wider one

Installation is a spawn, and `AGENTS.md` requires that every spawn goes through
the operation registry with `shell: false`, no cwd and no environment.

It goes through a **separate** registry, `createSetupOperationRegistry()`,
constructed only on the setup path and sharing the same `ProcessRunner` and the
same rules. The wire-facing registry does not contain `provider.install` at all.
The existing guarantee -- MCP gains no capability the UI lacks -- extends to
"and neither gains what setup has", enforced by construction rather than by a
flag that a future reader could misinterpret. A long-running daemon that can be
asked over a socket to fetch and execute an installer is precisely the failure
mode the registry exists to prevent.

The constraint is satisfiable without loosening anything.
`npm install --global --prefix <dir> <package>@<version>` carries the prefix as
an argv element, so an install needs no environment variable and no cwd, and
`npm` is a bare program name that passes the existing sweep unchanged.

## Authentication

Setup finishes with providers logged in, by driving each provider's own login
through the PTY supervisor the server role already has.

There is no way to avoid an interactive step: these logins are browser OAuth
flows, and on a headless LXC that means a URL opened elsewhere and a code pasted
back. Since setup is already a terminal program, it can host that exchange. It
is also the product's own mechanism -- driving an agent's TUI over a PTY is what
agentplex does -- so the login path exercises the same seam the product depends
on.

Where a provider's login cannot be driven, setup reports the state honestly and
prints what to run. An install that ends in "installed, not logged in" is a
worse outcome than one that ends logged in, and a far better outcome than
silence followed by a session that will not start.

## Pairing the local server

In `--role=both` the hub still dials its own local server over the loopback, so
a pairing must exist. Setup mints the token and writes both ends.

`2026-09-01` says "Pairing is always the user typing that server's token into
the hub", and this is a deliberate, narrow exception to it: the same operator,
on the same host, within a single interactive setup run, for a server reached
over the loopback. The rule exists because a hub that trusts a machine it has
not been told to trust is a hub anyone on the network can attach to; none of
that applies to a process the operator is installing beside the hub at that
moment. The exception does not extend to a remote server, to a non-interactive
run against a machine the plan did not name, or to any path where the hub is
choosing rather than the operator.

Making somebody hand-pair their own box would be ceremony with no security
value, and ceremony with no value is how a security rule gets a reputation for
being worth working around.

## Running as a person, not as root

The server role must not run as root. It spawns coding agents with the
operator's credentials, reads their provider state directories, and writes into
their project directories. Root-owned stores and root-run agents are a bad
outcome that is tedious to reverse.

So `curl | bash` installs for the invoking user, the owned prefix is
`~/.agentplex/bin`, and the systemd unit carries `User=`. A `--system` flag
installs under a dedicated service account for the fleet case, where there is no
human user to be. The hub alone has no such constraint, but in `--role=both` it
is the same process and therefore the same user.

## What the hub serves

Unchanged from `2026-09-01` and restated because installation depends on it: the
hub serves the PWA, the client websocket, the MCP endpoint and web push. These
are not separable. The MCP endpoint is specified as same-origin and token-authed,
and same-origin means something only because the hub serves the UI.

One consequence is currently unmet. The runtime image builds the PWA and does
not ship it -- `Dockerfile` copies `apps/agentplexd/dist`,
`packages/protocol/dist` and `migrations`, and never `apps/web/dist` -- and
`hub.ts` serves no static assets. A hub with nothing to serve is adequate for
milestone 1 and is not adequate for anything an installer produces.

## The release artifact

A bare machine must not need pnpm, vite, or a repository checkout. The
`agentplexd` package is published with the compiled service, the compiled
protocol, the built PWA and the migrations inside it, and installation is
`npm install --global agentplexd`. Node is already a prerequisite for a Node
service, npm arrives with it, upgrades are an install of a later version, and
version pinning is free.

One hazard is verified and must be handled rather than discovered. The
`allowBuilds` commentary in `pnpm-workspace.yaml` records that node-pty
"compiles a native addon and a `spawn-helper` binary beside it", so a bare
Debian container needs python3, make and a C++ compiler before that install
succeeds. Unhandled, it fails as an npm error nobody can read, on the first
command of the first install. `install.sh` installs the toolchain on the Linux
path, or the package ships prebuilds. This is the single most likely thing to
break a clean install and belongs in the acceptance criteria of the ticket that
writes the script.

## Work

1. `binPath` on `ServerConfig`; the child PATH built from it in both the process
   runner and the PTY supervisor, wired at `main.ts`, the only reader of
   `process.env`.
2. `agentplexd doctor`, and a startup preflight whose result reaches the
   handshake so a missing or logged-out provider is a named fact in the UI
   rather than an `ENOENT` when somebody taps start.
3. `ProviderProvisioning` on the provider seam, implemented for Claude Code.
4. `createSetupOperationRegistry()`, disjoint from the wire-facing registry.
5. `SetupPlan`: the type, its parser, and `setup --plan`.
6. The wizard, with injected terminal I/O so it is testable like everything else
   here.
7. Provider login driven through the PTY seam.
8. Local-server pairing in `--role=both`, under the exception recorded above.
9. The hub serves the built PWA; the image ships it.
10. The published package: contents, and the toolchain problem.
11. `install.sh`, the systemd units, and the LXC and EC2 documentation.
