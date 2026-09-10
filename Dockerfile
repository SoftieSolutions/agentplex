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
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/

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

# The bootstrap check: `install.sh` against the machine it was written for.
#
# The stage above installs the package on a box that already has Node and a
# compiler, which is the artifact's acceptance criterion. This one starts with
# neither, because ensuring both is what the script is for -- and every step of
# that is invisible from inside a workspace: a runtime downloaded and checksummed,
# a toolchain installed through sudo, a native addon compiled against a Node
# nobody put there.
FROM debian:bookworm-slim AS bootstrap-check

# Four packages, and each one models something the operator's machine already
# had rather than something agentplex needs.
#
# ca-certificates and curl are how the script arrived at all: `curl -fsSL
# https://... | bash` cannot happen on a box with no trust store and no curl,
# so a stage that installed neither would be testing a delivery nobody uses.
#
# sudo is the privilege an ordinary account has. Without it this could only test
# the already-root path, which is the one path the script refuses.
#
# systemd is here to be an authority and not to run: `systemd-analyze verify`
# below is systemd's own opinion of the unit the script wrote, which is worth
# more than any grep this repository could write for the same lines.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl sudo systemd \
    && rm -rf /var/lib/apt/lists/*

# A person, not root, which is the policy under test.
#
# Named `alice` and not `operator`: Debian's base image already ships an
# `operator` *group* at GID 37, and `useradd` refuses a user whose implied group
# exists, with an exit code of 9 and a message about `-g`. A stand-in name with
# no meaning to the distribution has no such collision to have.
RUN useradd --create-home alice \
    && echo 'alice ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/alice \
    && chmod 0440 /etc/sudoers.d/alice

COPY --from=package /package/ /package/
COPY apps/agentplexd/packaging/install.sh /install.sh

USER alice
ENV HOME=/home/alice
WORKDIR /home/alice
# Pipelines below carry the assertion, and sh's default is the exit status of
# the last command in one -- so without this a failing install ending in `tee`
# would be a green layer.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The run under test, as an unprivileged user on a machine with no Node and no
# compiler. --no-setup because a Docker build has no terminal: the script
# declines to open a wizard on one anyway, and asking for what is wanted beats
# depending on that.
#
# AGENTPLEX_PACKAGE is the seam. It points the install at the tarball the
# `package` stage just built, which is the only way to run this against a build
# that has never been published.
RUN AGENTPLEX_PACKAGE="$(echo /package/agentplexd-*.tgz)" \
    bash /install.sh --role=server --no-setup | tee /tmp/install.log

# What the script said it would do, read back off the machine.
#
# node first: nothing put one here, so an executable at this path is proof the
# download, the checksum and the unpack all happened. agentplexd second, which
# is proof npm ran under that node and node-gyp found the toolchain sudo
# installed -- the failure the whole toolchain decision exists to prevent.
RUN test -x "$HOME/.agentplex/bin/node" && test -x "$HOME/.agentplex/bin/agentplexd"
# The prefix is not put on a PATH for anybody, so the script has to say so.
RUN grep -q "export PATH=\"$HOME/.agentplex/bin:" /tmp/install.log

# The settings file: two facts the installer had, and 0600 because the client
# token belongs in this file.
RUN test "$(stat -c '%a' "$HOME/.agentplex/agentplexd.env")" = 600 \
    && grep -qx 'AGENTPLEX_ROLE=server' "$HOME/.agentplex/agentplexd.env" \
    && grep -qx "AGENTPLEX_BIN_PATH=$HOME/.agentplex/bin" "$HOME/.agentplex/agentplexd.env"

# The unit, and then systemd's own reading of it. `verify` resolves ExecStart,
# so it is also an assertion that the unit points at a program that is really
# there -- which is what makes this worth more than matching strings.
RUN test -f "$HOME/.config/systemd/user/agentplexd.service" \
    && grep -qx "ExecStart=$HOME/.agentplex/bin/agentplexd" "$HOME/.config/systemd/user/agentplexd.service" \
    && ! grep -q '^User=' "$HOME/.config/systemd/user/agentplexd.service" \
    && systemd-analyze verify "$HOME/.config/systemd/user/agentplexd.service"

# The ticket's own verification: a stock container, and `doctor` at the end of
# it reporting a provider it can find.
#
# Claude Code is installed here rather than by `agentplexd setup`, which is the
# ticket that installs providers and is not on this branch. It goes into the
# prefix the script created, through the npm that came with the Node the script
# installed, which is exactly what setup's install plan does.
ENV PATH=/home/alice/.agentplex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN npm install --global --prefix "$HOME/.agentplex" @anthropic-ai/claude-code

# What is asserted is the directory: the provider resolved out of the prefix
# this script created, which is the fact the whole binPath design exists to
# produce. `ready` is not asserted because `ready` additionally means logged in
# and a build has no credentials to log in with; `unknown` is allowed for the
# same kind of honesty, since the probe is the provider's own program running in
# a container with nothing else in it. `missing` is the failure this is here to
# catch, and none of the three that are allowed can be reached from it.
#
# `doctor` exits 1 because a logged-out provider is not usable, which is a true
# statement about this container, so the report is what is read and not the
# code. Reaching a report at all is also the node-pty assertion -- the process
# loads the addon on the way to printing one.
#
# The report goes to a file rather than through a pipe, and that is this stage's
# `pipefail` being taken seriously rather than worked around: under it, `doctor
# | grep` fails on doctor's exit 1 no matter what grep found. `|| true` is
# therefore deliberate and narrow -- the exit code of this one command is not
# the assertion, and the two lines below are.
RUN agentplexd doctor --role=server \
    --bin-path="$HOME/.agentplex/bin" \
    --server-identity-file="$HOME/.agentplex/server.json" >/tmp/doctor.log 2>&1 || true
RUN cat /tmp/doctor.log \
    && grep -Eq '^  claude +(ready|unauthenticated|unknown) +.*/home/alice/\.agentplex/bin$' /tmp/doctor.log

# The fleet path, which is a different account, a different prefix and a
# different unit scope. It runs as root because that is what it is for: it
# creates a service account and writes a system unit, and it still runs nothing
# as root -- the unit carries User=.
#
# PATH is put back to a machine's own first, so that this run finds no Node and
# installs its own into /opt/agentplex. Leaving alice's prefix on it would have
# this adopt a runtime inside another user's home directory, which is a Node the
# service account may not be able to read.
USER root
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# No --no-setup here: --system declines a wizard on its own, and the run has to
# say so rather than be told to.
RUN AGENTPLEX_PACKAGE="$(echo /package/agentplexd-*.tgz)" \
    bash /install.sh --system --role=hub | tee /tmp/system-install.log
RUN grep -q 'not run: --system machines take a plan' /tmp/system-install.log
RUN id agentplex \
    && test -x /opt/agentplex/bin/node \
    && test -x /opt/agentplex/bin/agentplexd \
    && test "$(stat -c '%U' /etc/agentplex/agentplexd.env)" = agentplex \
    && grep -qx 'User=agentplex' /etc/systemd/system/agentplexd.service \
    && grep -qx 'WantedBy=multi-user.target' /etc/systemd/system/agentplexd.service \
    && systemd-analyze verify /etc/systemd/system/agentplexd.service

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
COPY --from=runtime-deps /app/packages/node-shared/node_modules ./packages/node-shared/node_modules
COPY --from=runtime-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=runtime-deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY apps/agentplexd/package.json ./apps/agentplexd/
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY --from=build /app/apps/agentplexd/dist ./apps/agentplexd/dist
COPY --from=build /app/packages/node-shared/dist ./packages/node-shared/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
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
