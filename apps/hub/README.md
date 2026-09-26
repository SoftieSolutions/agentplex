# @softiesolutions/agentplex-hub

The agentplex hub daemon. It owns the database, serves the web app, and merges
what every paired server reports; clients talk to it and to nothing else.

This is not a command. There is no `agentplex hub` to type: the package carries
a compiled program, and what starts it is a systemd unit naming an interpreter
and that file.

Nothing here is on npm. Every release is a GitHub Release carrying one tarball,
so the version in it is a release tag and not a range, and `agentplex install`
is what resolves a version for you. The tarball carries an
`npm-shrinkwrap.json`, the dependency versions it was tested with, and npm
reads that only when the package is the project it installs into -- so it is
unpacked and installed in place, never with `npm install --global <url>`, which
ignores the shrinkwrap. [The procedure by hand](https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md#if-your-npm-is-configured-with-ignore-scripts) is in the command's
README.

The hub and the client are separate release trains, so their versions move
independently; what is current for each is published as `versions.json` on the
`v1` branch and is what an unpinned install reads. This package's manifest
carries an `agentplex.protocol` number, and a hub only talks to a server and a
client that declare the same one.

Install it with [the `agentplex` command](https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md),
which is what configures and checks a machine: `agentplex install --role=hub`
installs this package and the client beside it and writes the unit, and on a
machine with nothing on it yet `install.sh` puts a runtime and the command
there and hands over to it:

```sh
curl -fsSL https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh | bash -s -- --role=hub
```

## The MCP endpoint

An agent drives this hub the same way a person does, through `POST /mcp` --
streamable HTTP, on the port that serves the web app, authorized by
`Authorization: Bearer <client token>` and by nothing else. It is the same
credential the browser presents, because MCP reaches exactly what the UI
reaches: every tool calls a hub feature the client already has a screen for,
there is no generic-command tool and there will not be one, and a separate token
would be a second thing to rotate for no second capability. Same origin is the
point rather than a convenience -- one port, one certificate, one secret -- which
is why the hub serves the client itself. The endpoint keeps no session: each POST
is answered on its own, so `GET` and `DELETE` are refused with `405` and there is
nothing for an agent to hold open or clean up.

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
