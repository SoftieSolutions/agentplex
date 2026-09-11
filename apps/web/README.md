# @softiesolutions/agentplex-web

The agentplex web app, built. This package is the files a hub serves: the app
shell, the fingerprinted bundles, the fonts, the icons and the service worker.
There is no module in it to import and nothing in it to run.

It exists as a package of its own so that a hub can carry the client without
carrying the toolchain that made it -- no vite, no react, no typescript -- and
so that the client can be replaced without replacing the hub.

```sh
npm install --global @softiesolutions/agentplex-hub @softiesolutions/agentplex-web
```

`@softiesolutions/agentplex-hub` finds these files by resolving this package's
name and reading the `dist` beside the manifest it lands on, so the two are
installed as siblings and neither contains the other. A server machine installs
neither.

## License

Apache-2.0.
