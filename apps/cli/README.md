# agentplex

Watch and drive coding-agent sessions across machines. One package and one
bin, `agentplex`: `setup` is the wizard, `doctor` is the read-only check. The
hub and the server are daemons rather than subcommands -- nothing but
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

On a machine that has nothing on it yet, `install.sh` does the whole of that:
the Node runtime, the toolchain below, this package, and the systemd units, for
the user who runs it:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh | bash
```

The package carries the compiled programs, the compiled packages they share,
the built web app and the migrations, so a machine needs Node and nothing else
from this project: no pnpm, no vite, no checkout. Upgrading is
installing a later version, and pinning one is
`@softiesolutions/agentplex@<version>`.

## Installing a server needs a C++ toolchain on Linux; a hub does not

This is the one thing that will stop a clean install, so it is first.

The server drives coding agents through a real pseudoterminal, which means
[node-pty](https://github.com/microsoft/node-pty), a native addon. node-pty
ships prebuilt binaries for macOS and Windows only. On Linux there is no
prebuild, so npm compiles it from source at install time and node-gyp needs
`python3`, `make` and a C++ compiler. On a stock `debian:bookworm-slim` with
nothing but Node added, they are all absent.

The hub opens no pseudoterminal. It owns the database, serves the client and
merges what every paired server reports, and it depends on nothing that touches
a pty -- so node-pty is an **optional dependency** of this package, and a
hub-only machine installs with no compiler on it and nothing to compile. That
matters more than it sounds: the source build was both the only reason a hub
needed a toolchain and the step of the whole install most likely to fail.

For a server, install the toolchain first:

```sh
sudo apt-get install --no-install-recommends --yes python3 make g++   # Debian, Ubuntu
sudo dnf install --assumeyes python3 make gcc-c++                     # Fedora, RHEL
xcode-select --install                                                # macOS, if needed
```

`install.sh` does this for you on the Linux path, for `--role=server` and
`--role=both` and not for `--role=hub`.

### Optional does not mean optional for a server

npm exits `0` when an optional dependency's build fails: it removes the package
and prints nothing about it. On a hub that is exactly right. On a server it
would be a clean install and a session that never starts, so three things stand
between the two:

- the server refuses to start, naming node-pty and saying what to install,
  rather than dying inside a native addon before `main` runs.
- `agentplex doctor` reports the seam as `unusable` for any role that runs a
  server, and exits `1`.
- `install.sh` sets `AGENTPLEX_REQUIRE_PTY=1` for `--role=server` and
  `--role=both`. The package's `postinstall` reads it, and a node-pty it cannot
  load fails the install -- after which npm rolls the package back, rather than
  leaving behind a binary that cannot open a terminal. Without the variable the
  same script warns and lets the install finish, which is what a hub wants.

## If your npm is configured with `ignore-scripts`

node-pty needs its own install scripts to run: they are what compile the addon.
An npmrc with `ignore-scripts=true`, a reasonable hardening setting and not an
unusual one, produces an install that reports success and leaves node-pty as
source that cannot load, and then the server fails to start with a module
error rather than anything about a pty.

Override it for this package:

```sh
npm install --global --ignore-scripts=false @softiesolutions/agentplex
```

Two scripts run under that flag, and they are the whole of what this package
executes at install time:

- node-pty's own, which compiles the addon.
- agentplex's `postinstall`, which loads node-pty and then restores the
  executable bit on its `spawn-helper`. The npm tarball drops that bit from the
  prebuilt binaries, and the only symptom is `Error: posix_spawnp failed.` from
  inside a native addon for a session that never starts. It loads rather than
  resolves, because an `ignore-scripts` install leaves node-pty's sources in
  place with no addon beside them and only a load can tell the difference. It
  fails an install in exactly one case: `AGENTPLEX_REQUIRE_PTY` is set and
  node-pty will not load. Otherwise it warns and exits `0`.

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
