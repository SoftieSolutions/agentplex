# agentplex

Watch and drive coding-agent sessions across machines. One package and one
bin, `agentplex`, with four subcommands: `hub` and `server` are separate
daemons, `setup` is the wizard, `doctor` is the read-only check.

```sh
npm install --global agentplex
agentplex doctor --role=server --server-identity-file="$HOME/.agentplex/server.json"
```

On a machine that has nothing on it yet, `install.sh` does the whole of that:
the Node runtime, the toolchain below, this package, and the systemd units, for
the user who runs it:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/install/packaging/install.sh | bash
```

The package carries the five compiled programs, the compiled packages they
share, the built web app and the migrations, so a machine needs Node and
nothing else from this project: no pnpm, no vite, no checkout. Upgrading is
installing a later version, and pinning one is `agentplex@<version>`. A machine
that was installed as `agentplexd` finds its settings, identity and prefix at
the same paths; the installer retires the old unit and package.

## Installing needs a C++ toolchain on Linux

This is the one thing that will stop a clean install, so it is first.

The server drives coding agents through a real pseudoterminal, which means
[node-pty](https://github.com/microsoft/node-pty), a native addon. node-pty
ships prebuilt binaries for macOS and Windows only. On Linux there is no
prebuild, so npm compiles it from source at install time and node-gyp needs
`python3`, `make` and a C++ compiler. On a stock `debian:bookworm-slim` with
nothing but Node added, they are all absent, and the install fails inside
node-gyp with an error that says nothing about agentplex.

Install them first:

```sh
sudo apt-get install --no-install-recommends --yes python3 make g++   # Debian, Ubuntu
sudo dnf install --assumeyes python3 make gcc-c++                     # Fedora, RHEL
xcode-select --install                                                # macOS, if needed
```

`install.sh` does this for you on the Linux path. If you are installing by hand
on a machine that has never built a native module, this is the step to do first.

## If your npm is configured with `ignore-scripts`

node-pty needs its own install scripts to run: they are what compile the addon.
An npmrc with `ignore-scripts=true`, a reasonable hardening setting and not an
unusual one, produces an install that reports success and leaves node-pty as
source that cannot load, and then `agentplex server` fails to start with a
module error rather than anything about a pty.

Override it for this package:

```sh
npm install --global --ignore-scripts=false agentplex
```

Two scripts run under that flag, and they are the whole of what this package
executes at install time:

- node-pty's own, which compiles the addon.
- agentplex's `postinstall`, which restores the executable bit on node-pty's
  `spawn-helper`. The npm tarball drops it from the prebuilt binaries, and the
  only symptom is `Error: posix_spawnp failed.` from inside a native addon for a
  session that never starts. The script reads one file mode, may `chmod` one
  file, prints what it changed, and never fails an install.

## Checking a machine

`agentplex doctor` reads the settings the installer wrote and reports what
they can actually start: per provider the version, the directory it resolved
from and whether it says it is logged in; per store, whether the path is
there. It binds no port, opens no database, opens no pty and writes nothing.
It exits `0` when everything it looked at is usable and `1` when anything is
not, so it can be a check in a script.

## License

Apache-2.0.
