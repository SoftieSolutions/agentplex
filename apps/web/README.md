# @softiesolutions/agentplex-web

The agentplex web app, built. This package is the files a hub serves: the app
shell, the fingerprinted bundles, the fonts, the icons and the service worker.
There is no module in it to import and nothing in it to run.

It exists as a package of its own so that a hub can carry the client without
carrying the toolchain that made it -- no vite, no react, no typescript -- and
so that the client can be replaced without replacing the hub.

```sh
agentplex install --role=hub   # the hub, with this package beside it
```

Nothing here is on npm. Every release is a GitHub Release carrying one tarball,
so the version in it is a release tag and not a range, and `agentplex install`
is what resolves a version for you -- or `install.sh --role=hub`, on a machine
that does not have the command yet. The tarball carries an
`npm-shrinkwrap.json`, and npm reads that only when the package is the project
it installs into, so it is unpacked and installed in place, never with `npm
install --global <url>`, which ignores the shrinkwrap. [The procedure by
hand](https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md#if-your-npm-is-configured-with-ignore-scripts) is in the command's README.

`@softiesolutions/agentplex-hub` finds these files by resolving this package's
name and reading the `dist` beside the manifest it lands on, so the two are
installed as siblings and neither contains the other. A server machine installs
neither.

## License

Apache-2.0.
