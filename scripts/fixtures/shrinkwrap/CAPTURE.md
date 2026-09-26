# The shrinkwrap derivation's lockfile

`pnpm-lock.yaml` here was written by pnpm, not by hand. `pnpm-workspace.yaml`
beside it is the workspace file pnpm read to write it, and the assembly reads
its `allowBuilds` the way it reads the real one's.

Captured 2026-09-26, pnpm 11.17.0 (the `packageManager` pin at the time), node
v24.18.1, against registry.npmjs.org.

## The workspace

A scratch directory outside the repository, laid out as the manifests in
`scripts/assemble-package.test.ts` describe the real one: the same directories,
names and dependency ranges, every version `1.2.3`. `packages/pty` declares
`node-pty: 1.1.0`, as the real one does.

One member exists only here, `apps/probe`, to give the derivation the three
cases the real closures may or may not happen to hold on any given day:

```json
{
  "name": "@agentplex/probe",
  "version": "1.2.3",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "dependencies": {
    "debug": "4.3.1",
    "supports-color": "7.2.0",
    "ms": "2.1.3",
    "@agentplex/protocol": "workspace:*"
  },
  "optionalDependencies": { "fsevents": "2.3.3" },
  "devDependencies": { "picocolors": "1.1.1" }
}
```

- `debug@4.3.1` with `supports-color` in the tree: pnpm writes the version with
  a peer suffix, `4.3.1(supports-color@7.2.0)`, and lists the optional peer
  under the snapshot's `optionalDependencies`.
- `debug@4.3.1` needs `ms@2.1.2` while the member asks for `ms@2.1.3`: two
  versions of one package, one of which has to nest.
- `fsevents` is optional and carries `os`; `picocolors` is a dev dependency.

## The commands

```sh
mkdir agx-slot-4-AGX-323-workspace && cd agx-slot-4-AGX-323-workspace
# package.json: {"name":"agentplex-workspace","version":"1.2.3","private":true,
#   "license":"Apache-2.0","type":"module",
#   "engines":{"node":">=24","pnpm":">=11"},"packageManager":"pnpm@11.17.0"}
# pnpm-workspace.yaml: as beside this file
# apps/{cli,hub,server,web,probe}/package.json and
# packages/{protocol,node-shared,providers,release,pty}/package.json:
#   the test constants above, plus apps/probe
corepack pnpm --version          # 11.17.0
corepack pnpm install --lockfile-only
cp pnpm-lock.yaml pnpm-workspace.yaml <repo>/scripts/fixtures/shrinkwrap/
```

To recapture, rebuild the directory the same way and run the same two pnpm
commands; do not edit the YAML.
