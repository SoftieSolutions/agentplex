# @softiesolutions/agentplex-server

The agentplex server daemon. It runs coding-agent sessions on its own machine
through a pseudoterminal and watches the stores on its disk. It holds no
database and dials out to nothing -- the hub dials it.

This is not a command. There is no `agentplex server` to type: the package
carries a compiled program, and what starts it is a systemd unit naming an
interpreter and that file.

```sh
npm install --global https://github.com/SoftieSolutions/agentplex/releases/download/server-v1.0.0/agentplex-server.tgz
node "$(npm root -g)/@softiesolutions/agentplex-server/apps/server/dist/main.js" --help
```

Nothing here is on npm. Every release is a GitHub Release carrying one tarball,
and npm installs it from that URL -- so the version in it is a release tag and
not a range. `install.sh` is what resolves a version for you.

This package's manifest carries an `agentplex.protocol` number, and a server
only pairs with a hub that declares the same one.

Install it with [the `agentplex` command](https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md),
which is what configures and checks a machine, and let `install.sh
--role=server` write the unit:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh | bash -s -- --role=server
```

## This package needs a C++ toolchain on Linux

Every session a server runs is driven through a real pseudoterminal, which means
[node-pty](https://github.com/microsoft/node-pty), a native addon. node-pty
ships prebuilt binaries for macOS and Windows only; on Linux npm compiles it
from source and node-gyp needs `python3`, `make` and a C++ compiler.

It is a required dependency here, deliberately. A server without a
pseudoterminal is not a degraded server, so npm failing the install at the
compile -- with node-gyp's own error, naming the compiler -- is a better outcome
than an install that reports success and a session that never starts.

```sh
sudo apt-get install --no-install-recommends --yes python3 make g++   # Debian, Ubuntu
sudo dnf install --assumeyes python3 make gcc-c++                     # Fedora, RHEL
xcode-select --install                                                # macOS, if needed
```

`install.sh` does this for you on the Linux path for `--role=server` and
`--role=both`. An npm configured with `ignore-scripts=true` skips the build that
makes node-pty usable, so this package's install needs
`--ignore-scripts=false`, which is what `install.sh` passes.

## License

Apache-2.0.
