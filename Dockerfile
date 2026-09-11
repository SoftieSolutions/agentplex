# syntax=docker/dockerfile:1

# One image, every program. Baking one daemon in would give us two images of the
# same package and a way for them to drift apart, so the image stays one and the
# command picks the daemon; a container that wants both runs two services from
# the same image.
#
# What changed is how the command names it. The entrypoint used to be the
# agentplex bin and the command was the word `hub`, which worked because `hub`
# was a subcommand of that bin. It is not one any more -- a daemon is not a
# command, and `agentplex hub` now answers by explaining what a hub is -- so the
# entrypoint is `node` and the command is the daemon's compiled entry.
#
# That is the same shape the systemd unit renders, and deliberately so: an
# installed machine runs `<node> <prefix>/lib/node_modules/@softiesolutions/
# agentplex-hub/apps/hub/dist/main.js` and this image runs `node
# apps/hub/dist/main.js`, which is the same expression with the package root
# spelled differently. One way to start a daemon rather than two -- and the
# property the old arrangement was actually after survives untouched: the
# command still picks the daemon, and flags appended to `docker run` still land
# as that daemon's.

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
COPY apps/hub/package.json ./apps/hub/
COPY apps/cli/package.json ./apps/cli/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY packages/pty/package.json ./packages/pty/
COPY scripts/package.json ./scripts/
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

# The publishable packages, and then the install nobody in this repository can
# otherwise perform: a machine that has never seen this checkout.
#
# `pnpm package` stages each tarball's contents and `npm pack` seals them. Both
# run here rather than on a laptop because the thing being tested is what a
# stranger gets, and a laptop with a warm pnpm store cannot tell you that.
#
# Four now, into one directory: the command, the hub, the server and the client.
# That directory is what AGENTPLEX_PACKAGE names further down -- the seam is a
# directory rather than a spec precisely because there are four of them and a
# check that installed three of ours beside one from a registry would be
# reporting on a build it had not installed.
FROM build AS package
RUN pnpm --filter ./scripts package \
    && mkdir -p /package \
    && for release in apps/*/release; do (cd "$release" && npm pack --pack-destination /package); done \
    && ls -1 /package

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

# The command, the server and the hub's pair, as four tarballs a bare npm is
# handed with no flags to help it along. npm 11.19 warns that node-pty's and the
# pty package's install scripts are "not yet covered by allowScripts" and runs
# them anyway; an npm that starts enforcing that gate turns this line red, which
# is the whole reason for testing an install rather than reasoning about one.
#
# Each is named by the same pattern `install.sh` uses, and for the same reason:
# `softiesolutions-agentplex-*.tgz` matches all four, because every other name
# starts with the command's. npm's tarballs are `<flattened name>-<version>.tgz`
# and a version starts with a digit, which is what tells the four apart without
# writing a version into this file.
RUN set -eu; \
    specs=''; \
    for name in agentplex agentplex-hub agentplex-server agentplex-web; do \
      specs="$specs $(ls /package/softiesolutions-$name-[0-9]*.tgz)"; \
    done; \
    echo "installing:$specs"; \
    npm install --global $specs

# Six assertions. `doctor` reaches its report only by the bin consuming the
# command word, loading the command's module out of its own `dist`, and that
# module loading every package it imports, so a report on stdout is proof the
# dispatch and the bundled packages both resolve from the installed tree. It exits 1 on this machine because no coding agent is
# installed on it, which is a true statement about the container and not a
# packaging failure, so the report is what gets asserted and not the code.
RUN agentplex doctor --role=server --server-identity-file=/var/lib/agentplex/server.json \
    | tee /dev/stderr | grep -qx providers
# The server is the program that loads node-pty, and a program that cannot
# load it dies before it can refuse a flag: reaching its usage is proof the
# addon compiled here and can be loaded.
#
# Reached by its file rather than by a command word, because there is no
# `agentplex server` to type any more. This is the literal ExecStart an install
# on this machine would render -- npm's global root, then the workspace path the
# tarball preserves -- so it proves what it always did and one thing more: that
# the path a systemd unit names resolves from an installed tree, with every
# bundled package under it.
RUN node "$(npm root -g)/@softiesolutions/agentplex-server/apps/server/dist/main.js" --role=server 2>&1 \
    | grep -q 'Usage: agentplex server'
# The schema travels inside the hub package or the hub has no database to open.
# Read back out of the installed tree, at the path `main.js` resolves rather
# than the path packaging wrote.
RUN test -f "$(npm root -g)/@softiesolutions/agentplex-hub/apps/hub/migrations/0001_hub_identity.sql"

# The client, resolved rather than found: this is the claim the split rests on
# and the one that cannot be made anywhere else in this repository.
#
# The hub no longer counts directories to the client -- `../../web/dist` from
# its own dist would name a directory inside its own package -- it resolves
# `@softiesolutions/agentplex-web`. Here the two are sibling directories under
# one global root, which is the arrangement an installed machine has and no
# checkout does: Node walks up out of the hub's package to `<prefix>/lib` and
# finds `<prefix>/lib/node_modules` there.
#
# Asked from the hub's own `dist`, because that is where the question is asked
# from in the program. `--input-type=module --eval` gives the evaluated module
# the URL `<cwd>/[eval1]`, so the walk starts exactly where `main.js`'s does.
#
# The `index.html` at the end is the assertion that matters. The specifier
# resolving proves the package is installed; only reading a file out of the
# directory proves the build is where the hub expects it, which is the half that
# was wrong the first time this was run against a real install.
RUN cd "$(npm root -g)/@softiesolutions/agentplex-hub/apps/hub/dist" \
    && root="$(node --input-type=module --eval 'import {fileURLToPath} from "node:url"; process.stdout.write(fileURLToPath(new URL("./dist", import.meta.resolve("@softiesolutions/agentplex-web/package.json"))))')" \
    && echo "resolved web root: $root" \
    && test -f "$root/index.html"
# `--version`, against what the installed manifest declares rather than against
# an exit code. The bin reads that manifest at a path it resolves from its own
# URL, and the manifest the workspace keeps beside the bin is not in the package
# at all -- so the version this prints is the whole of the evidence that it read
# the right file, and asserting only that the command exits 0 would have been
# green for the release where it printed an ENOENT instead. It is here rather
# than in a suite because a suite runs in a checkout, where both files exist.
RUN declared="$(node -p "require('$(npm root -g)/@softiesolutions/agentplex/package.json').version")" \
    && printed="$(agentplex --version)" \
    && test "$printed" = "$declared" \
    || { echo "agentplex --version printed '$printed', manifest declares '$declared'" >&2; exit 1; }

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
COPY scripts/install.sh /install.sh

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
# AGENTPLEX_PACKAGE is the seam. It points the install at the directory of
# tarballs the `package` stage just built, which is the only way to run this
# against a build that has never been published. A directory rather than a spec,
# because the release is four packages: the script picks out the ones this role
# needs, and stops naming the missing one if the directory does not hold them.
RUN AGENTPLEX_PACKAGE=/package \
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
    && grep -qx "ExecStart=$HOME/.agentplex/node/bin/node $HOME/.agentplex/lib/node_modules/@softiesolutions/agentplex-server/apps/server/dist/main.js" "$HOME/.config/systemd/user/agentplex-server.service" \
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
    && ! test -e "$HOME/.agentplex/lib/node_modules/@softiesolutions" \
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
RUN AGENTPLEX_PACKAGE=/package \
    bash /install.sh --system --role=hub | tee /tmp/system-install.log
RUN grep -q 'not run: --system machines take a plan' /tmp/system-install.log
RUN id agentplex \
    && test -x /opt/agentplex/node/bin/node \
    && test -x /opt/agentplex/bin/agentplex \
    && grep -qx 'User=agentplex' /etc/systemd/system/agentplex-hub.service \
    && grep -qx 'ExecStart=/opt/agentplex/node/bin/node /opt/agentplex/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js' /etc/systemd/system/agentplex-hub.service \
    && ! test -e /etc/systemd/system/agentplex-server.service \
    && grep -qx 'WantedBy=multi-user.target' /etc/systemd/system/agentplex-hub.service \
    && systemd-analyze verify /etc/systemd/system/agentplex-hub.service
# Who owns what, which on this machine is a security boundary and not
# bookkeeping. The service account runs coding agents, so everything it owns is
# within reach of a session that gets out of one.
#
# The runtime is the assertion that matters: `node` under /opt/agentplex/node is
# the interpreter this unit's ExecStart resolves through, and an account that
# owned it could replace the interpreter and be re-executed on every restart
# after that. The prefix root and lib/ are root's for the same reason -- so
# nothing new can be dropped beside them -- and bin/, lib/node_modules/ and
# share/ are the account's because `agentplex setup` installs providers into
# them as that account.
#
# It says what it found before it decides. A chain of silent `test`s fails with
# "exit code 1" and does not say which of nine paths was wrong, which is one bit
# per build of a machine that takes six minutes to make; this prints the owner
# of every path and fails at the end on the ones that disagreed. MISSING is a
# path that is not there at all -- `stat` exits 2 and prints nothing, which a
# chain would have reported as the same one bit.
RUN wrong=''; \
    printf '%-10s %-10s %s\n' FOUND EXPECTED PATH; \
    for pair in /opt/agentplex/node:root \
        /opt/agentplex/node/bin/node:root \
        /opt/agentplex:root \
        /opt/agentplex/lib:root \
        /opt/agentplex/bin:agentplex \
        /opt/agentplex/lib/node_modules:agentplex \
        /opt/agentplex/lib/node_modules/@softiesolutions/agentplex:agentplex \
        /opt/agentplex/lib/node_modules/@softiesolutions/agentplex-hub:agentplex \
        /opt/agentplex/lib/node_modules/@softiesolutions/agentplex-web:agentplex \
        /opt/agentplex/share:agentplex \
        /var/lib/agentplex:agentplex; do \
      path="${pair%:*}"; expected="${pair##*:}"; \
      owner="$(stat -c '%U' "$path" 2>/dev/null || echo MISSING)"; \
      printf '%-10s %-10s %s\n' "$owner" "$expected" "$path"; \
      [ "$owner" = "$expected" ] || wrong="$wrong $path"; \
    done; \
    [ -z "$wrong" ] || { echo "owner is not what this install should produce:$wrong" >&2; exit 1; }
# The whole runtime, not the two paths above. A nodejs.org tarball's entries are
# owned by the account that built the release, so a `tar -x` as root restored a
# uid no machine has for every file under it -- the interpreter included. The
# claim is about the tree, so the assertion is about the tree.
RUN find /opt/agentplex/node ! -user root -printf '%u %p\n' | tee /tmp/node-foreign.log \
    && test ! -s /tmp/node-foreign.log

# The settings file, which holds the client token: root's, group-readable by the
# account so the daemon can read its own configuration, and 0640 so it cannot
# rewrite it and nobody else on the machine can read it.
RUN test "$(stat -c '%U:%G' /etc/agentplex/agentplex.env)" = root:agentplex \
    && test "$(stat -c '%a' /etc/agentplex/agentplex.env)" = 640

# The same boundary as the account itself sees it, which is the form a provider
# install and a compromised session both arrive in. Writing is what setup does
# and has to keep working; the refusals are the whole point of the split. The
# probes are removed again so that the uninstall below still meets the tree it
# expects.
RUN su agentplex -s /bin/sh -c 'touch /opt/agentplex/bin/probe /opt/agentplex/lib/node_modules/probe /opt/agentplex/share/probe /var/lib/agentplex/probe' \
    && ! su agentplex -s /bin/sh -c 'touch /opt/agentplex/node/bin/probe' \
    && ! su agentplex -s /bin/sh -c 'touch /opt/agentplex/probe' \
    && ! su agentplex -s /bin/sh -c 'echo x >>/etc/agentplex/agentplex.env' \
    && su agentplex -s /bin/sh -c 'grep -q AGENTPLEX_ROLE /etc/agentplex/agentplex.env' \
    && rm -f /opt/agentplex/bin/probe /opt/agentplex/lib/node_modules/probe /opt/agentplex/share/probe /var/lib/agentplex/probe

# The two-unit shape, which is the one this epic exists for on a single box:
# `--role=both` renders both units, and each starts one daemon.
RUN bash /install.sh --system --role=both --print-unit >/tmp/both-units.txt \
    && grep -qx 'ExecStart=/opt/agentplex/node/bin/node /opt/agentplex/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js' /tmp/both-units.txt \
    && grep -qx 'ExecStart=/opt/agentplex/node/bin/node /opt/agentplex/lib/node_modules/@softiesolutions/agentplex-server/apps/server/dist/main.js' /tmp/both-units.txt

# The fleet uninstall, which is a different scope, a different prefix and a
# different set of things to leave alone. The service account stays: it owns
# /var/lib/agentplex and the database in it, and an account removed out from
# under a directory it owns is a state directory nobody can read.
RUN bash /install.sh --system --uninstall | tee /tmp/system-uninstall.log
RUN ! test -e /etc/systemd/system/agentplex-hub.service \
    && ! test -e /opt/agentplex/node \
    && ! test -e /opt/agentplex/lib/node_modules/@softiesolutions \
    && test -f /etc/agentplex/agentplex.env \
    && id agentplex \
    && grep -q '/etc/agentplex/agentplex.env' /tmp/system-uninstall.log

# The hub bootstrap: the claim this ticket is actually about, on the only
# machine that can prove it.
#
# A separate stage rather than another `RUN` in the one above, and that is the
# whole reason it exists: `bootstrap-check` installs python3, make and g++
# through sudo on its first line of real work, so every hub install after that
# point runs on a machine that already has a compiler and proves nothing. The
# claim is that a hub needs none, and the only way to state it is a container
# where none was ever installed.
#
# It costs a second Debian layer, a second Node download and a second npm
# install -- and no compile, because there is nothing here to compile, which is
# the point. It is the cheaper of the two bootstrap stages for exactly the
# reason it is being added.
#
# systemd is here for the same reason it is above: `systemd-analyze verify`
# resolves ExecStart, so it is systemd's own word that the unit points at a hub
# that is really there.
FROM debian:bookworm-slim AS hub-bootstrap-check

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl sudo systemd \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home alice \
    && echo 'alice ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/alice \
    && chmod 0440 /etc/sudoers.d/alice

COPY --from=package /package/ /package/
COPY scripts/install.sh /install.sh

USER alice
ENV HOME=/home/alice
WORKDIR /home/alice
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# alice has passwordless sudo, exactly as above, so a script that wanted to
# install a toolchain could. This asserts that it did not want to.
RUN AGENTPLEX_PACKAGE=/package \
    bash /install.sh --role=hub --no-setup | tee /tmp/hub-install.log

# No compiler on the machine, before or after. `cc`, `c++` and `g++` are all
# absent from a stock bookworm-slim, so finding one here would mean this install
# put it here -- which is the regression this stage exists to catch. The log
# line beside it is the other half: the step was skipped as a decision and said
# so, rather than being quietly dropped.
RUN ! command -v g++ \
    && ! command -v c++ \
    && ! command -v cc \
    && grep -q 'toolchain  not needed' /tmp/hub-install.log

# And the install worked anyway: the bin, the runtime and the unit all arrived,
# and no server unit came with them.
RUN test -x "$HOME/.agentplex/node/bin/node" \
    && test -x "$HOME/.agentplex/bin/agentplex" \
    && test -f "$HOME/.config/systemd/user/agentplex-hub.service" \
    && ! test -e "$HOME/.config/systemd/user/agentplex-server.service" \
    && grep -qx "ExecStart=$HOME/.agentplex/node/bin/node $HOME/.agentplex/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js" "$HOME/.config/systemd/user/agentplex-hub.service" \
    && systemd-analyze verify "$HOME/.config/systemd/user/agentplex-hub.service"

# The role table, read off the machine: this install took the command, the hub
# and the client, and no server package came with them. `web` is not a role and
# is not optional for a hub -- the hub finds the client by resolving that name,
# and a hub without it serves 503.
RUN root="$HOME/.agentplex/lib/node_modules/@softiesolutions"; \
    ls -1 "$root" \
    && test -d "$root/agentplex" \
    && test -d "$root/agentplex-hub" \
    && test -d "$root/agentplex-web" \
    && ! test -e "$root/agentplex-server"

# The hub finding the client, on a machine laid out the way an install lays one
# out and no checkout does: two sibling packages under one prefix. Asked from
# the hub's own `dist`, because that is where the program asks it -- Node gives
# an evaluated module the URL `<cwd>/[eval1]`, so the walk up through
# `node_modules` starts exactly where `main.js`'s does.
RUN cd "$HOME/.agentplex/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist" \
    && root="$(node --input-type=module --eval 'import {fileURLToPath} from "node:url"; process.stdout.write(fileURLToPath(new URL("./dist", import.meta.resolve("@softiesolutions/agentplex-web/package.json"))))')" \
    && echo "resolved web root: $root" \
    && test -f "$root/index.html"

# What this machine no longer carries, which is the whole reason the release is
# four packages rather than one.
#
# node-pty is the native addon with no Linux prebuild, and the compile it needs
# is the likeliest step of any install to fail. Under the single tarball it was
# an optional dependency of a package every machine installed, so on a box like
# this npm tried the compile, failed it and exited 0 having quietly removed it
# -- an install that worked by being allowed to skip something.
#
# What is asserted is the packaging rather than what npm did with it: the hub's
# package and the client's ask for node-pty nowhere, so on this machine there
# was never anything for a compiler to be needed by. The command's manifest
# still declares it optional, so whether npm left any of it behind is npm's
# behaviour and not a claim this repository should make -- hence the whole tree
# is printed and only those two are searched.
#
# `-name node-pty` exactly, not a prefix: the command package carries a
# `node-pty-postinstall.js`, which is the script that repairs node-pty and not
# node-pty. The two searches are of manifests and code, because the hub's README
# explains at length what a hub does not carry.
RUN root="$HOME/.agentplex/lib/node_modules"; \
    echo 'anything named node-pty under the prefix:'; \
    find "$root" -name node-pty -print; \
    ! grep -rq --include='*.json' --include='*.js' 'node-pty' "$root/@softiesolutions/agentplex-hub" \
    && ! grep -rq --include='*.json' --include='*.js' 'node-pty' "$root/@softiesolutions/agentplex-web"

ENV PATH=/home/alice/.agentplex/bin:/home/alice/.agentplex/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The hub's own doctor, which is the end-to-end statement: a program that loads
# every bundled package, reports a machine that opens no terminals, and exits 0
# on a box with no compiler on it. Exit 0 is the assertion here, unlike the
# server stage above, because on a hub there is nothing left that could be
# unusable.
RUN agentplex doctor --role=hub | tee /tmp/hub-doctor.log
RUN grep -q 'opens no terminals' /tmp/hub-doctor.log

# The other half of the same decision is deliberately not asserted here. A
# `--role=server` run on this machine would install the toolchain through the
# same passwordless sudo alice has above and then compile node-pty perfectly
# well -- which is the correct behaviour and no evidence at all about a machine
# that cannot compile. What happens on a server when node-pty will not load is
# the postinstall's own test in `packages/pty`, where the failure can be
# arranged rather than hoped for.

# Runtime dependencies only, resolved on their own rather than pruned out of
# the build stage: a prune leaves whatever it failed to notice.
#
# The bin app is selected by path, because its directory is the only name it
# has that a filter cannot confuse with another manifest. The braces are load
# bearing: `--filter ./apps/cli...` reads the trailing `...` as part of the
# path and silently selects the one package without its dependencies, where
# `--filter {./apps/cli}...` is the directory plus what it needs. Verified
# against pnpm 11.17.
#
# The client is excluded, and the exclusion is what keeps the split honest here.
# The hub declares it, so `@agentplex/hub...` now selects it and would install
# react, mantine, xterm and the fonts into a store this image copies whole --
# a browser framework in the runtime tree of a program that serves bytes. What
# the hub actually needs from the client is the link, and pnpm creates that as
# part of installing the hub rather than as part of installing the client: run
# rather than reasoned about, `apps/hub/node_modules/@softiesolutions/
# agentplex-web -> ../../../web` is there with the client excluded, and
# `apps/web/node_modules` is not, and react is nowhere in the store.
FROM manifests AS runtime-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "{./apps/cli}..." --filter @agentplex/hub... --filter @agentplex/server... --filter '!@softiesolutions/agentplex-web'

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The workspace layout is kept rather than flattened: the dependency tree that
# pnpm linked is a web of relative symlinks, and it resolves only where it was
# linked. `migrations/` sits beside the hub's `dist/` because its main.js
# resolves it as ../migrations relative to itself, and the entrypoint below
# names a daemon's `dist/main.js` at the workspace path it has in a checkout.
COPY --from=runtime-deps /app/node_modules ./node_modules
# The bin's own, which did not exist while this app declared no runtime
# dependency: it holds the wizard and the doctor now, so the symlinks that
# resolve `@agentplex/*` and `zod` from `apps/cli/dist/commands/**` are here and
# nowhere a resolver walking up from that directory would otherwise find them.
COPY --from=runtime-deps /app/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=runtime-deps /app/apps/hub/node_modules ./apps/hub/node_modules
COPY --from=runtime-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=runtime-deps /app/packages/node-shared/node_modules ./packages/node-shared/node_modules
COPY --from=runtime-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=runtime-deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY --from=runtime-deps /app/packages/pty/node_modules ./packages/pty/node_modules
# The workspace manifest, which in this image is the package root's: the bin
# resolves `--version` three levels up from its own `dist`, the same expression
# that finds the published manifest in the tarball. Without this file here that
# one command is an ENOENT in an image where every other one works, which is
# exactly the shape of failure the expression exists to avoid.
COPY package.json ./
COPY apps/cli/package.json ./apps/cli/
COPY apps/hub/package.json ./apps/hub/
COPY apps/server/package.json ./apps/server/
COPY packages/node-shared/package.json ./packages/node-shared/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY packages/pty/package.json ./packages/pty/
# The client's manifest, which is what the hub resolves to find the client: the
# link in apps/hub/node_modules points here, and a package directory with no
# manifest in it is a resolution that lands somewhere Node cannot name.
COPY apps/web/package.json ./apps/web/
COPY --from=build /app/apps/cli/dist ./apps/cli/dist
COPY --from=build /app/apps/hub/dist ./apps/hub/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/node-shared/dist ./packages/node-shared/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/packages/pty/dist ./packages/pty/dist
COPY apps/hub/migrations ./apps/hub/migrations
# The client. It is static files: the runtime needs the bytes and none of the
# dependencies that made them, which is why this is a copy out of `build` and
# not a second entry in `runtime-deps`.
#
# The path is the workspace's, as everything here is, but the hub no longer
# reaches it by counting directories. It resolves `@softiesolutions/agentplex-
# web`, which in this image means the link copied in with apps/hub/node_modules
# above -- a relative link, so it still lands on /app/apps/web -- and then the
# `dist` beside the manifest copied in above that. Three homes, one specifier:
# see apps/hub/src/web/web-package.ts.
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
# port of the daemon that is actually running: the server's entry means the
# server's port, anything else the hub's. Nothing here reads AGENTPLEX_ROLE,
# because the daemons do not.
#
# It matches `apps/server/` inside an argument rather than an argument equal to
# `server`, which is what it did while the command was the word. The word is
# gone; the path is what pid 1 is now started with, and a substring test over
# the whole of it would say "server" of any argument that happened to contain
# it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "const argv=require('node:fs').readFileSync('/proc/1/cmdline','utf8').split('\\0');const port=argv.some((a)=>a.includes('apps/server/'))?(process.env.AGENTPLEX_SERVER_PORT||'8081'):(process.env.AGENTPLEX_HUB_PORT||'8080');fetch('http://127.0.0.1:'+port+'/health').then((r)=>{if(!r.ok)throw new Error(port+' answered '+r.status);process.exit(0);},(error)=>{console.error(String(error));process.exit(1);});"]

# Exec form, so node is pid 1 and Docker's SIGTERM reaches the handler in the
# daemon's main.ts directly -- which is now true more simply than it was, since
# there is no bin process in front of it to have been pid 1 instead.
#
# The command is the daemon's entry, relative to the WORKDIR above. The hub is
# the default because a bare `docker run` of this image is somebody trying the
# thing the compose file brings up; `docker run <image> apps/server/dist/
# main.js` is the other one, and anything appended after it lands as that
# daemon's flags exactly as before.
ENTRYPOINT ["node"]
CMD ["apps/hub/dist/main.js"]
