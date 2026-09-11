# agentplex

Watch and drive coding-agent sessions across machines. This package is the
command, `agentplex`: `setup` is the wizard, `doctor` is the read-only check.
The hub and the server are daemons rather than subcommands -- nothing but
`agentplex` is installed onto your PATH, and the units `install.sh` writes are
what start them.

```sh
npm install --global @softiesolutions/agentplex
agentplex doctor --role=server --server-identity-file="$HOME/.agentplex/server.json"
```

The package is `@softiesolutions/agentplex` and the command is `agentplex`. The
unscoped name on npm is an unrelated placeholder somebody else registered, and a
`bin` key is not a package name, so the registry entry is scoped and nothing you
type is.

On a machine that has nothing on it yet, `install.sh` does the whole of it: the
Node runtime, the toolchain if this machine needs one, the packages the role
needs, and the systemd units, for the user who runs it:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh | bash
```

## Four packages, and what your machine installs

A release is four packages, and a machine installs only what it runs.

| package                             | what it is                                  | who installs it                |
| ----------------------------------- | ------------------------------------------- | ------------------------------ |
| `@softiesolutions/agentplex`        | this one: the command, `setup` and `doctor` | every machine                  |
| `@softiesolutions/agentplex-hub`    | the hub daemon and its migrations           | `--role=hub`, `--role=both`    |
| `@softiesolutions/agentplex-web`    | the built web app the hub serves            | with the hub                   |
| `@softiesolutions/agentplex-server` | the server daemon                           | `--role=server`, `--role=both` |

`web` is not a role. It is part of being a hub: the hub finds the client by
resolving that package name, and the two are installed as siblings.

Every package carries the compiled programs it runs and the compiled workspace
packages those import, so a machine needs Node and nothing else from this
project: no pnpm, no vite, no checkout. Upgrading is installing a later version,
and pinning one is `@softiesolutions/agentplex@<version>`.

## Installing a server needs a C++ toolchain on Linux; a hub does not

This is the one thing that will stop a clean install, so it is first.

The server drives coding agents through a real pseudoterminal, which means
[node-pty](https://github.com/microsoft/node-pty), a native addon. node-pty
ships prebuilt binaries for macOS and Windows only. On Linux there is no
prebuild, so npm compiles it from source at install time and node-gyp needs
`python3`, `make` and a C++ compiler. On a stock `debian:bookworm-slim` with
nothing but Node added, they are all absent.

A hub opens no pseudoterminal. It owns the database, serves the client and
merges what every paired server reports, and neither
`@softiesolutions/agentplex-hub` nor `@softiesolutions/agentplex-web` has
node-pty anywhere in its dependency set. This package declares it optional, so
npm is allowed to skip it -- which means no package a hub-only machine installs
can fail for want of a compiler. That matters more than it sounds: the source
build was both the only reason a hub needed a toolchain and the step of the
whole install most likely to fail.

For a server, install the toolchain first:

```sh
sudo apt-get install --no-install-recommends --yes python3 make g++   # Debian, Ubuntu
sudo dnf install --assumeyes python3 make gcc-c++                     # Fedora, RHEL
xcode-select --install                                                # macOS, if needed
```

`install.sh` does this for you on the Linux path, for `--role=server` and
`--role=both` and not for `--role=hub`.

### Required in the server package, optional in this one

node-pty is a **required** dependency of `@softiesolutions/agentplex-server`.
npm exits `0` when an _optional_ dependency's build fails -- it removes the
package and prints nothing about it -- which on a server would be a clean
install and a session that never starts. Required means npm fails that install
itself, at the compile, with node-gyp's own error naming the compiler.

In this package it is **optional**, deliberately. Every machine installs the
command, hub-only ones included, and a hub-only machine is exactly the one that
may have no compiler. What a missing node-pty costs here is narrow and reported:

- `agentplex doctor` reports the pty seam as `unusable` for any role that runs
  a server, and exits `1`.
- `agentplex setup` cannot log a provider in through a terminal. Everything
  else it writes, it still writes.
- an agentplex server refuses to start, naming node-pty and saying what to
  install, rather than dying inside a native addon before `main` runs.

## If your npm is configured with `ignore-scripts`

node-pty needs its own install scripts to run: they are what compile the addon.
An npmrc with `ignore-scripts=true`, a reasonable hardening setting and not an
unusual one, produces an install that reports success and leaves node-pty as
source that cannot load, and then the server fails to start with a module
error rather than anything about a pty.

Override it:

```sh
npm install --global --ignore-scripts=false @softiesolutions/agentplex
```

Two scripts run under that flag, and they are the whole of what this package
executes at install time:

- node-pty's own, which compiles the addon.
- a `postinstall`, which loads node-pty and then restores the executable bit on
  its `spawn-helper`. The npm tarball drops that bit from the prebuilt binaries,
  and the only symptom is `Error: posix_spawnp failed.` from inside a native
  addon for a session that never starts. It loads rather than resolves, because
  an `ignore-scripts` install leaves node-pty's sources in place with no addon
  beside them and only a load can tell the difference. It never fails an
  install: it warns and exits `0`, and the machine where a missing node-pty is
  not survivable is the one where npm has already refused.

## Checking a machine

`agentplex doctor` reads the settings the installer wrote and reports what
they can actually start: whether a pseudoterminal can be opened at all; per
provider the version, the directory it resolved from and whether it says it is
logged in; per store, whether the path is there. It binds no port, opens no
database, opens no pty and writes nothing -- it asks whether node-pty loads,
which maps a file and starts nothing. It exits `0` when everything it looked at
is usable and `1` when anything is not, so it can be a check in a script.

On a `--role=hub` machine it reports all three as questions that do not apply,
because a hub starts no sessions, mounts no stores and opens no terminals.

## License

Apache-2.0.
