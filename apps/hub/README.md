# @softiesolutions/agentplex-hub

The agentplex hub daemon. It owns the database, serves the web app, and merges
what every paired server reports; clients talk to it and to nothing else.

This is not a command. There is no `agentplex hub` to type: the package carries
a compiled program, and what starts it is a systemd unit naming an interpreter
and that file.

```sh
npm install --global \
  https://github.com/SoftieSolutions/agentplex/releases/download/hub-v1.0.0/agentplex-hub.tgz \
  https://github.com/SoftieSolutions/agentplex/releases/download/web-v1.0.0/agentplex-web.tgz
node "$(npm root -g)/@softiesolutions/agentplex-hub/apps/hub/dist/main.js" --help
```

Nothing here is on npm. Every release is a GitHub Release carrying one tarball,
and npm installs it from that URL -- so the version in it is a release tag and
not a range. `install.sh` is what resolves a version for you.

The hub and the client are separate release trains, so their versions move
independently; what is current for each is published as `versions.json` on the
`v1` branch and is what an unpinned install reads. This package's manifest
carries an `agentplex.protocol` number, and a hub only talks to a server and a
client that declare the same one.

Install it with [the `agentplex` command](https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md),
which is what configures and checks a machine, and let `install.sh --role=hub`
write the unit:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh | bash -s -- --role=hub
```

## What a hub does not carry

Nothing in this package's dependency set reaches
[node-pty](https://github.com/microsoft/node-pty). Only a server opens a
pseudoterminal, and node-pty has no Linux prebuild, so it is compiled from
source at install time by a C++ toolchain. Nothing here asks for one, and
`@softiesolutions/agentplex` declares node-pty optional, so a hub installs on a
stock `debian:bookworm-slim` with nothing but Node on it.

## The web app is a separate package

`@softiesolutions/agentplex-web` holds the built client, and the hub finds it by
resolving that package name rather than by a path inside its own tree. Install
it beside the hub. Without it the hub still starts, still opens its database,
still pairs servers and still answers `/health`; it says at startup that there
is no client to serve, and answers the client routes with `503`.

## License

Apache-2.0.
