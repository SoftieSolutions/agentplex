# syntax=docker/dockerfile:1

# One image, both roles. The role is a runtime choice — AGENTPLEX_ROLE, or a
# --role flag appended to `docker run` — because baking it in would give us two
# images of the same program and a way for them to drift apart.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Non-interactive corepack: without this it stops to ask before fetching pnpm,
# and a build has nobody to answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json .npmrc ./
# `corepack install` reads the version out of packageManager, so the pinned
# pnpm lives in exactly one place.
RUN corepack enable && corepack install

# Manifests before sources: the install layer is then reused across every edit
# that does not touch a dependency.
FROM base AS manifests
# node-pty is a native addon and ships prebuilt binaries for macOS and Windows
# only, so on Linux it is compiled at install time and node-gyp needs a
# toolchain. This image has none: without these, `pnpm install` fails on a
# missing python3 in a stage that has nothing to do with node-pty. They stay in
# this stage and never reach the runtime image, which copies the compiled
# result rather than building anything.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/agentplexd/package.json ./apps/agentplexd/
# The install runs agentplexd's postinstall, which repairs the executable bit
# on node-pty's spawn helper, so the script has to be here before the install
# and not arrive later with the sources.
COPY apps/agentplexd/scripts ./apps/agentplexd/scripts
COPY apps/web/package.json ./apps/web/
COPY packages/protocol/package.json ./packages/protocol/

# The full workspace: every dependency, every source file, everything built.
# This is what the test compose file runs its checks in, so a check in a
# container sees the same tree a check on a laptop does.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Typecheck and tests both resolve @agentplex/protocol through its built
# declarations, so the build is a precondition for checking, not a step after.
RUN pnpm build

# The publishable package, and then the install nobody in this repository can
# otherwise perform: a machine that has never seen this checkout.
#
# `pnpm package` stages the tarball's contents and `npm pack` seals them. Both
# run here rather than on a laptop because the thing being tested is what a
# stranger gets, and a laptop with a warm pnpm store cannot tell you that.
FROM build AS package
RUN pnpm --filter agentplexd package \
    && mkdir -p /package \
    && cd apps/agentplexd/release \
    && npm pack --pack-destination /package

# The clean-install check. Stock `debian:bookworm-slim` with nothing but Node
# added, which is the machine `install.sh` will meet.
FROM debian:bookworm-slim AS install-check
# Node, npm and corepack, taken from the official image rather than a distro
# package, so the version is the one this workspace declares. `/usr/local` is
# where that image keeps all three.
COPY --from=node:24-bookworm-slim /usr/local /usr/local
# The toolchain decision, made visible. node-pty ships prebuilt binaries for
# macOS and Windows only, so on Linux npm compiles the addon and node-gyp needs
# python3, make and a C++ compiler; without them the very first command of the
# very first install dies inside node-gyp with an error that names neither
# agentplex nor a missing compiler. `install.sh` (AGX-78) installs exactly these
# on the Linux path, and this line is what that decision looks like when
# something checks it. ca-certificates is not part of it: a bare Debian has no
# trust store at all, so npm could not reach a registry over TLS to fail at
# node-gyp in the first place.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /package/ /package/

# Deliberately the ticket's own command, with no flags to help it along. npm
# 11.19 warns that node-pty's and agentplexd's install scripts are "not yet
# covered by allowScripts" and runs them anyway; an npm that starts enforcing
# that gate turns this line red, which is the whole reason for testing an
# install rather than reasoning about one.
RUN npm install --global /package/agentplexd-*.tgz

# Three assertions, and the first is the one that matters. `doctor` reaches its
# report only by loading every module `main.js` imports, and node-pty is among
# them: a report on stdout is proof that the native addon was compiled here and
# can be loaded. It exits 1 on this machine because no coding agent is installed
# on it, which is a true statement about the container and not a packaging
# failure, so the report is what gets asserted and not the code.
RUN agentplexd doctor --role=server --server-identity-file=/var/lib/agentplex/server.json \
    | tee /dev/stderr | grep -qx providers
# The client and the schema travel inside the package or the hub has nothing to
# serve and no database to open. Read back out of the installed tree, at the
# paths `main.js` resolves rather than the paths packaging wrote.
RUN test -f "$(npm root -g)/agentplexd/apps/web/dist/index.html" \
    && test -f "$(npm root -g)/agentplexd/apps/agentplexd/migrations/0001_hub_identity.sql"

# Runtime dependencies only, resolved on their own rather than pruned out of
# the build stage: a prune leaves whatever it failed to notice.
FROM manifests AS runtime-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter agentplexd...

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The workspace layout is kept rather than flattened: the dependency tree that
# pnpm linked is a web of relative symlinks, and it resolves only where it was
# linked. `migrations/` sits beside `dist/` because main.js resolves it as
# ../migrations relative to itself.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/apps/agentplexd/node_modules ./apps/agentplexd/node_modules
COPY --from=runtime-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY apps/agentplexd/package.json ./apps/agentplexd/
COPY packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/apps/agentplexd/dist ./apps/agentplexd/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY apps/agentplexd/migrations ./apps/agentplexd/migrations
# The client. The build stage already produced it and this image dropped it
# until now, which made every image an installer could produce a hub with
# nothing to serve. It is static files: the runtime needs the bytes and none of
# the dependencies that made them, which is why this is a copy out of `build`
# and not a second entry in `runtime-deps`. The path is the workspace's,
# because main.js resolves it as ../../web/dist relative to itself, exactly the
# way it resolves ../migrations.
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Somewhere for the hub's database to live. The directory has to exist in the
# image, owned by the user that will write to it: Docker seeds a fresh named
# volume from whatever is at the mount point, ownership included, and a mount
# point the image does not have is created root-owned, which the node user
# cannot then open a database in. There is no VOLUME instruction to go with it
# on purpose — that would hand a bare `docker run` an anonymous volume, and an
# anonymous volume is the failure the compose file's named one exists to avoid.
RUN install --directory --owner=node --group=node /var/lib/agentplex

# The node user ships with the image. Everything the hub writes goes to that
# directory, which it owns, and the application tree stays read-only to it, so
# root buys it nothing.
USER node

EXPOSE 8080 8081

# The health check reads the same environment the process does, so a container
# that picks its role with a flag instead of AGENTPLEX_ROLE should set the env
# var too or its health will be measured on the wrong port.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "const role=process.env.AGENTPLEX_ROLE||'hub';const ports=[];if(role!=='server')ports.push(process.env.AGENTPLEX_HUB_PORT||'8080');if(role!=='hub')ports.push(process.env.AGENTPLEX_SERVER_PORT||'8081');Promise.all(ports.map((p)=>fetch('http://127.0.0.1:'+p+'/health').then((r)=>{if(!r.ok)throw new Error(p+' answered '+r.status);}))).then(()=>process.exit(0),(error)=>{console.error(String(error));process.exit(1);});"]

# Exec form, so node is pid 1 and Docker's SIGTERM reaches the handler in
# main.ts directly. Anything appended to `docker run` lands here as flags.
ENTRYPOINT ["node", "apps/agentplexd/dist/main.js"]
