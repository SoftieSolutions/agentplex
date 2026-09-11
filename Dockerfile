# syntax=docker/dockerfile:1

# One image, every program. The entrypoint is the agentplex bin and the command
# picks the daemon -- `hub` or `server` -- because baking one in would give us
# two images of the same package and a way for them to drift apart. A container
# that wants both runs two services from the same image.

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
COPY apps/doctor/package.json ./apps/doctor/
COPY apps/hub/package.json ./apps/hub/
COPY apps/install/package.json ./apps/install/
COPY apps/server/package.json ./apps/server/
COPY apps/setup/package.json ./apps/setup/
COPY apps/web/package.json ./apps/web/
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY packages/pty/package.json ./packages/pty/
COPY tests/hub-server/package.json ./tests/hub-server/
# The install runs the pty package's postinstall, which repairs the executable
# bit on node-pty's spawn helper, so the script has to be here before the
# install and not arrive later with the sources.
COPY packages/pty/scripts ./packages/pty/scripts

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
RUN pnpm --filter agentplex package \
    && mkdir -p /package \
    && cd apps/install/release \
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
# 11.19 warns that node-pty's and agentplex's install scripts are "not yet
# covered by allowScripts" and runs them anyway; an npm that starts enforcing
# that gate turns this line red, which is the whole reason for testing an
# install rather than reasoning about one.
RUN npm install --global /package/agentplex-*.tgz

# Four assertions. `doctor` reaches its report only by the bin dispatching to
# it by path and the doctor loading every package it imports, so a report on
# stdout is proof the dispatch and the bundled packages both resolve from the
# installed tree. It exits 1 on this machine because no coding agent is
# installed on it, which is a true statement about the container and not a
# packaging failure, so the report is what gets asserted and not the code.
RUN agentplex doctor --role=server --server-identity-file=/var/lib/agentplex/server.json \
    | tee /dev/stderr | grep -qx providers
# The server is the program that loads node-pty, and a program that cannot
# load it dies before it can refuse a flag: reaching its usage is proof the
# addon compiled here and can be loaded.
RUN agentplex server --role=server 2>&1 | grep -q 'Usage: agentplex server'
# The client and the schema travel inside the package or the hub has nothing to
# serve and no database to open. Read back out of the installed tree, at the
# paths `main.js` resolves rather than the paths packaging wrote.
RUN test -f "$(npm root -g)/agentplex/apps/web/dist/index.html" \
    && test -f "$(npm root -g)/agentplex/apps/hub/migrations/0001_hub_identity.sql"

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
COPY apps/install/packaging/install.sh /install.sh

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
RUN AGENTPLEX_PACKAGE="$(echo /package/agentplex-*.tgz)" \
    bash /install.sh --role=server --no-setup | tee /tmp/install.log

# What the script said it would do, read back off the machine.
#
# node first: nothing put one here, so an executable at this path is proof the
# download, the checksum and the unpack all happened. It is under `node/` and
# not in the prefix's own `bin/`, and the two absences beside it are the rest of
# that split: `include/` and `share/` are the tarball's, and a prefix that has
# them is a prefix the runtime was unpacked over. agentplex second, which is
# proof npm ran under that node and node-gyp found the toolchain sudo installed
# -- the failure the whole toolchain decision exists to prevent.
RUN test -x "$HOME/.agentplex/node/bin/node" \
    && test -x "$HOME/.agentplex/bin/agentplex" \
    && ! test -e "$HOME/.agentplex/include" \
    && ! test -e "$HOME/.agentplex/share"
# The prefix is not put on a PATH for anybody, so the script has to say so.
RUN grep -q "export PATH=\"$HOME/.agentplex/bin:" /tmp/install.log

# The settings file: the three facts the installer had, and 0600 because the
# client token belongs in this file. The prefix is one of them because a setup
# run later on this machine has no other way to find the one that was chosen --
# asserted here rather than in a second install into a custom prefix, which
# would download and compile everything above a second time for one line.
RUN test "$(stat -c '%a' "$HOME/.agentplex/agentplex.env")" = 600 \
    && grep -qx 'AGENTPLEX_ROLE=server' "$HOME/.agentplex/agentplex.env" \
    && grep -qx "AGENTPLEX_PREFIX=$HOME/.agentplex" "$HOME/.agentplex/agentplex.env" \
    && grep -qx "AGENTPLEX_BIN_PATH=$HOME/.agentplex/bin" "$HOME/.agentplex/agentplex.env"

# The unit, and then systemd's own reading of it. `verify` resolves ExecStart,
# so it is also an assertion that the unit points at a program that is really
# there -- which is what makes this worth more than matching strings. One unit
# for `--role=server`, and no hub unit beside it.
RUN test -f "$HOME/.config/systemd/user/agentplex-server.service" \
    && ! test -e "$HOME/.config/systemd/user/agentplex-hub.service" \
    && grep -qx "ExecStart=$HOME/.agentplex/bin/agentplex server" "$HOME/.config/systemd/user/agentplex-server.service" \
    && ! grep -q '^User=' "$HOME/.config/systemd/user/agentplex-server.service" \
    && grep -qx "Environment=PATH=$HOME/.agentplex/bin:$HOME/.agentplex/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "$HOME/.config/systemd/user/agentplex-server.service" \
    && systemd-analyze verify "$HOME/.config/systemd/user/agentplex-server.service"

# The ticket's own verification: a stock container, and `doctor` at the end of
# it reporting a provider it can find.
#
# Claude Code is installed here rather than by `agentplex setup`, which is the
# ticket that installs providers and is not on this branch. It goes into the
# prefix the script created, through the npm that came with the Node the script
# installed, which is exactly what setup's install plan does.
# Both directories, in the order the unit gets them: the binary and the
# providers are linked into the prefix's bin, and the runtime their shebangs
# resolve now lives in a directory of its own.
ENV PATH=/home/alice/.agentplex/bin:/home/alice/.agentplex/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
RUN agentplex doctor --role=server \
    --bin-path="$HOME/.agentplex/bin" \
    --server-identity-file="$HOME/.agentplex/server.json" >/tmp/doctor.log 2>&1 || true
RUN cat /tmp/doctor.log \
    && grep -Eq '^  claude +(ready|unauthenticated|unknown) +.*/home/alice/\.agentplex/bin$' /tmp/doctor.log

# Undoing it, which is the only place an uninstall can be exercised against
# something that was really installed. A dry run can be asserted in the suite
# and the removals cannot: there is no machine to throw away anywhere else, and
# this stage is a machine to throw away with a real install on it.
#
# It runs last in this stage on purpose. Everything above has already been
# asserted, so nothing after this depends on the tree it takes apart -- and the
# root stage below deliberately starts from a machine with no Node, which is now
# doubly true.
RUN bash /install.sh --uninstall | tee /tmp/uninstall.log

# The runtime, the package and the units are gone.
RUN ! test -e "$HOME/.agentplex/node" \
    && ! test -e "$HOME/.agentplex/bin/agentplex" \
    && ! test -e "$HOME/.agentplex/lib/node_modules/agentplex" \
    && ! test -e "$HOME/.config/systemd/user/agentplex-server.service"

# And what it deliberately did not take with them. The settings file is state
# and comes back from nowhere; `claude` was installed into this prefix by
# something that is not this script, and a prefix swept clean would have taken
# it. Both are named in the log rather than only left behind, because an
# operator who wants this machine empty has no other list.
RUN test -f "$HOME/.agentplex/agentplex.env" \
    && test -x "$HOME/.agentplex/bin/claude" \
    && grep -q 'Left in place' /tmp/uninstall.log \
    && grep -q "$HOME/.agentplex/agentplex.env" /tmp/uninstall.log

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
RUN AGENTPLEX_PACKAGE="$(echo /package/agentplex-*.tgz)" \
    bash /install.sh --system --role=hub | tee /tmp/system-install.log
RUN grep -q 'not run: --system machines take a plan' /tmp/system-install.log
RUN id agentplex \
    && test -x /opt/agentplex/node/bin/node \
    && test -x /opt/agentplex/bin/agentplex \
    && test "$(stat -c '%U' /etc/agentplex/agentplex.env)" = agentplex \
    && grep -qx 'User=agentplex' /etc/systemd/system/agentplex-hub.service \
    && grep -qx 'ExecStart=/opt/agentplex/bin/agentplex hub' /etc/systemd/system/agentplex-hub.service \
    && ! test -e /etc/systemd/system/agentplex-server.service \
    && grep -qx 'WantedBy=multi-user.target' /etc/systemd/system/agentplex-hub.service \
    && systemd-analyze verify /etc/systemd/system/agentplex-hub.service
# The two-unit shape, which is the one this epic exists for on a single box:
# `--role=both` renders both units, and each starts one daemon.
RUN bash /install.sh --system --role=both --print-unit >/tmp/both-units.txt \
    && grep -qx 'ExecStart=/opt/agentplex/bin/agentplex hub' /tmp/both-units.txt \
    && grep -qx 'ExecStart=/opt/agentplex/bin/agentplex server' /tmp/both-units.txt

# The fleet uninstall, which is a different scope, a different prefix and a
# different set of things to leave alone. The service account stays: it owns
# /var/lib/agentplex and the database in it, and an account removed out from
# under a directory it owns is a state directory nobody can read.
RUN bash /install.sh --system --uninstall | tee /tmp/system-uninstall.log
RUN ! test -e /etc/systemd/system/agentplex-hub.service \
    && ! test -e /opt/agentplex/node \
    && ! test -e /opt/agentplex/lib/node_modules/agentplex \
    && test -f /etc/agentplex/agentplex.env \
    && id agentplex \
    && grep -q '/etc/agentplex/agentplex.env' /tmp/system-uninstall.log

# Runtime dependencies only, resolved on their own rather than pruned out of
# the build stage: a prune leaves whatever it failed to notice.
FROM manifests AS runtime-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter agentplex... --filter @agentplex/hub... --filter @agentplex/server... --filter @agentplex/setup... --filter @agentplex/doctor...

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The workspace layout is kept rather than flattened: the dependency tree that
# pnpm linked is a web of relative symlinks, and it resolves only where it was
# linked. `migrations/` sits beside the hub's `dist/` because its main.js
# resolves it as ../migrations relative to itself, and the bin reaches the four
# programs' `dist/` directories by the same relative paths it does in a
# checkout.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/apps/hub/node_modules ./apps/hub/node_modules
COPY --from=runtime-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=runtime-deps /app/apps/setup/node_modules ./apps/setup/node_modules
COPY --from=runtime-deps /app/apps/doctor/node_modules ./apps/doctor/node_modules
COPY --from=runtime-deps /app/packages/node-shared/node_modules ./packages/node-shared/node_modules
COPY --from=runtime-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=runtime-deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY --from=runtime-deps /app/packages/pty/node_modules ./packages/pty/node_modules
COPY apps/install/package.json ./apps/install/
COPY apps/hub/package.json ./apps/hub/
COPY apps/server/package.json ./apps/server/
COPY apps/setup/package.json ./apps/setup/
COPY apps/doctor/package.json ./apps/doctor/
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY packages/pty/package.json ./packages/pty/
COPY --from=build /app/apps/install/dist ./apps/install/dist
COPY --from=build /app/apps/hub/dist ./apps/hub/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/setup/dist ./apps/setup/dist
COPY --from=build /app/apps/doctor/dist ./apps/doctor/dist
COPY --from=build /app/packages/node-shared/dist ./packages/node-shared/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/packages/pty/dist ./packages/pty/dist
COPY apps/hub/migrations ./apps/hub/migrations
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

# The health check reads the command pid 1 was started with, so it probes the
# port of the daemon that is actually running: `server` is the server's port,
# anything else the hub's. Nothing here reads AGENTPLEX_ROLE, because the
# daemons do not.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "const argv=require('node:fs').readFileSync('/proc/1/cmdline','utf8').split('\\0');const port=argv.includes('server')?(process.env.AGENTPLEX_SERVER_PORT||'8081'):(process.env.AGENTPLEX_HUB_PORT||'8080');fetch('http://127.0.0.1:'+port+'/health').then((r)=>{if(!r.ok)throw new Error(port+' answered '+r.status);process.exit(0);},(error)=>{console.error(String(error));process.exit(1);});"]

# Exec form, so node is pid 1 and Docker's SIGTERM reaches the handler in the
# daemon's main.ts directly. The command picks the daemon; anything appended to
# `docker run` after it lands as that daemon's flags.
ENTRYPOINT ["node", "apps/install/dist/main.js"]
CMD ["hub"]
