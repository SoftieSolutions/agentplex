#!/usr/bin/env bash
#
# The agentplex bootstrap.
#
#   curl -fsSL <url> | bash                      # role=both, then setup
#   curl -fsSL <url> | bash -s -- --role=server  # server only
#   curl -fsSL <url> | bash -s -- --role=hub     # hub only
#   curl -fsSL <url> | bash -s -- --no-setup     # stop after the binary lands
#
# Deliberately ignorant. It ensures a Node runtime and the build toolchain,
# installs the published package, writes the systemd units it does not start --
# one for `agentplex server`, one for `agentplex hub`, both for --role=both --
# and hands over to `agentplex setup`. It knows nothing about providers, stores or
# databases: everything provider-specific lives in TypeScript beside the adapter
# that knows the provider, so a new provider is a new file rather than an edit
# to a shell script nobody tests.
#
# Two settings are the exception, and the line is drawn where this script's own
# knowledge ends. It writes AGENTPLEX_ROLE, because --role is its own flag, and
# AGENTPLEX_BIN_PATH, because the prefix is the directory it just made. It never
# writes a database path, a store path or a token, because it has no way to know
# one and a guessed value is worse than an absent one.
#
# Everything below is a function and `main` is the last line, so a download that
# is cut short does nothing at all rather than half of something. That is not
# decoration: `curl | bash` hands bash a stream, and bash executes what it has
# read so far.

set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "install.sh: this script needs bash; run it as: bash install.sh [options]" >&2
  exit 1
fi

# The script's own version, so a bug report can name the bytes that ran. It is
# the major of the URL below: /v1/install.sh keeps meaning what a command
# written today meant, and a change that breaks a documented invocation is a
# second path rather than an edit to this one.
readonly INSTALL_SH_VERSION='1'

# Where this script is served from, in one place.
#
# The constraints, which are the settled part: HTTPS, a path the project
# controls, and a version in that path so a pinned command keeps fetching the
# same bytes. The value below satisfies all three today -- a tag names an
# immutable tree, and GitHub serves it over TLS.
#
# A short alias in front of it (get.<domain>/v1/install.sh) is the part that is
# pending, and it is pending on a registration rather than on a decision. No
# unregistered domain is printed anywhere in this repository as a command to
# run: publishing `curl | bash` against a name nobody has registered is an
# invitation for somebody else to register it, and the day that happens the
# instruction still looks exactly right.
#
# `apps/install/README.md` prints this string and a test holds the two
# together, so
# there is one place to change when the alias exists.
readonly INSTALL_SH_URL='https://raw.githubusercontent.com/SoftieSolutions/agentplex/<tag>/apps/install/packaging/install.sh'

readonly PACKAGE_NAME='agentplex'
# The name this package was installed under before the split. A machine that
# has it is upgraded in place: the old unit goes, the old package goes, and the
# settings, identity and prefix are found where they were.
readonly OLD_PACKAGE_NAME='agentplexd'

# The dist-tag npm resolves when nothing is pinned. Named, because the spec
# always carries a `@` suffix: `agentplex` and `agentplex@latest` mean the
# same thing to npm, and one shape is one shape to read in a log line and one
# shape a test asserts on. This is the same choice `claude-provisioning.ts`
# makes for the same reason.
readonly NPM_LATEST_TAG='latest'

# The Node major this service declares in `engines`. `.npmrc` sets
# engine-strict, so an older runtime is refused by npm rather than discovered at
# the first import.
readonly NODE_MAJOR='24'
readonly NODE_DIST_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"

# What node-gyp needs to build node-pty on Linux. node-pty ships prebuilt
# binaries for macOS and Windows only, so on Linux the addon is compiled at
# install time; without these the very first command of the very first install
# dies inside node-gyp with an error naming neither agentplex nor a compiler.
readonly TOOLCHAIN_APT='python3 make g++'
readonly TOOLCHAIN_DNF='python3 make gcc-c++'
readonly TOOLCHAIN_APK='python3 make g++'

# The fleet layout: a dedicated service account, a prefix under /opt, state
# under /var/lib and configuration under /etc, which is where an operator looks
# for each of those.
readonly SYSTEM_ACCOUNT='agentplex'
readonly SYSTEM_PREFIX='/opt/agentplex'
readonly SYSTEM_STATE_DIR='/var/lib/agentplex'
readonly SYSTEM_CONFIG_DIR='/etc/agentplex'
readonly SYSTEM_UNIT_DIR='/etc/systemd/system'

readonly DOCS_URL='https://github.com/SoftieSolutions/agentplex/blob/master/apps/install/README.md'

# The PATH this script was started with, kept because the script changes its own
# further down. What the summary has to answer is whether the operator's shell
# will find `agentplex` tomorrow, and asking that of a PATH this run has
# already prepended the prefix to would answer yes every time.
readonly ORIGINAL_PATH="${PATH:-}"

# Options, and what the run resolved them to. Set once by the two functions
# below and read everywhere else.
ROLE='both'
RUN_SETUP='yes'
SYSTEM='no'
DRY_RUN='no'
PRINT_UNIT='no'
VERSION=''
PREFIX=''
BIN_DIR=''
ENV_FILE=''
UNIT_DIR=''
UNIT_SCOPE=''
# The daemons this role runs, one unit each. Set by resolve_layout.
DAEMONS=''
SERVICE_USER=''
STATE_DIR=''
PACKAGE_SPEC=''
PLATFORM=''
ARCH=''
NODE_DIR=''
NODE_ACTION=''

usage() {
  cat <<USAGE
agentplex install.sh ${INSTALL_SH_VERSION}

Usage: bash install.sh [options]

  --role=<hub|server|both>  which roles this machine runs (default: both)
  --no-setup                stop once the binary lands; run setup yourself
  --system                  install under a dedicated service account (needs root)
  --version=<version>       the ${PACKAGE_NAME} version to install (default: ${NPM_LATEST_TAG})
  --prefix=<directory>      install somewhere other than the default prefix
  --dry-run                 print what this would do and change nothing
  --print-unit              print the systemd units this would write, and stop
  --help                    this

  --role pre-seeds setup rather than replacing it. --no-setup is for a machine
  that will receive a plan file and run \`${PACKAGE_NAME} setup --plan\` itself.

  Served from ${INSTALL_SH_URL}
  Documentation at ${DOCS_URL}
USAGE
}

main() {
  parse_arguments "$@"
  resolve_layout

  if [ "$PRINT_UNIT" = 'yes' ]; then
    local daemon
    for daemon in $DAEMONS; do
      render_unit "$daemon"
    done
    return 0
  fi

  detect_platform
  say "agentplex install.sh ${INSTALL_SH_VERSION}"
  say ''

  ensure_toolchain
  ensure_node
  # Before anything is written, because the environment file below is chowned to
  # this account and a chown to a user that does not exist yet stops the run
  # after the package has landed -- half an install, and the confusing half.
  ensure_service_account
  install_package
  write_environment_file
  retire_old_unit
  write_units
  run_setup
  summary
}

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

# An unknown option stops the run rather than being ignored, for the reason
# `config.ts` gives about flags: installing the wrong thing because `--rle` was
# silently dropped is worse than not installing.
parse_arguments() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --role=*) ROLE="${1#*=}" ;;
      --version=*) VERSION="${1#*=}" ;;
      --prefix=*) PREFIX="${1#*=}" ;;
      --no-setup) RUN_SETUP='no' ;;
      --system) SYSTEM='yes' ;;
      --dry-run) DRY_RUN='yes' ;;
      --print-unit) PRINT_UNIT='yes' ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option $1"
        ;;
    esac
    shift
  done

  case "$ROLE" in
    hub) DAEMONS='hub' ;;
    server) DAEMONS='server' ;;
    both) DAEMONS='hub server' ;;
    *) die "unknown role $(quote "$ROLE"): expected one of hub, server, both" ;;
  esac

  if [ -n "$PREFIX" ] && [ "${PREFIX#/}" = "$PREFIX" ]; then
    die "--prefix must be an absolute path, not $(quote "$PREFIX")"
  fi
}

# Who this installs for, and where.
#
# The rule the spec argues and this enforces: the server role must not run as
# root. It spawns coding agents with the operator's credentials, reads their
# provider state directories and writes into their project directories, and
# root-owned stores and root-run agents are tedious to reverse. So a plain run
# installs for the invoking user, and root has exactly one supported path --
# --system, which does not run anything as root either: it makes a service
# account and the unit carries User=.
resolve_layout() {
  local uid
  uid="$(id -u)"

  if [ "$SYSTEM" = 'yes' ]; then
    [ "$uid" = '0' ] || die '--system installs a service account and a system unit, so it must run as root'
    SERVICE_USER="$SYSTEM_ACCOUNT"
    [ -n "$PREFIX" ] || PREFIX="$SYSTEM_PREFIX"
    STATE_DIR="$SYSTEM_STATE_DIR"
    # The settings file keeps the name it had before the split, so a machine
    # installed as agentplexd and upgraded through this finds it where it was.
    ENV_FILE="$SYSTEM_CONFIG_DIR/agentplexd.env"
    UNIT_DIR="$SYSTEM_UNIT_DIR"
    UNIT_SCOPE='system'
    # The fleet tier is the one with no human to answer a wizard. Its
    # configuration arrives as a plan file, replayed as the service account, so
    # a --system run never opens an interactive setup even when a terminal
    # happens to be attached.
    RUN_SETUP='no'
  else
    [ "$uid" != '0' ] || die 'refusing to install as root: agentplex runs coding agents as you, and root-owned stores are tedious to undo. Run this as your own user, or pass --system to install under a service account'
    [ -n "${HOME:-}" ] || die 'HOME is not set, so there is no user prefix to install into'
    SERVICE_USER="$(id -un)"
    [ -n "$PREFIX" ] || PREFIX="$HOME/.agentplex"
    STATE_DIR="$PREFIX"
    ENV_FILE="$PREFIX/agentplexd.env"
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT_SCOPE='user'
  fi

  BIN_DIR="$PREFIX/bin"
  resolve_node_directory

  # AGENTPLEX_PACKAGE is the seam this repository's own container check installs
  # through: it points the install at a tarball built from a checkout, which is
  # the only way to exercise this script against a package that is not published
  # yet. It takes anything `npm install` takes.
  if [ -n "${AGENTPLEX_PACKAGE:-}" ]; then
    PACKAGE_SPEC="$AGENTPLEX_PACKAGE"
  else
    PACKAGE_SPEC="${PACKAGE_NAME}@${VERSION:-$NPM_LATEST_TAG}"
  fi
}

detect_platform() {
  local kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$kernel" in
    Linux) PLATFORM='linux' ;;
    Darwin) PLATFORM='darwin' ;;
    *) die "unsupported system $(quote "$kernel"): this script installs on Linux and macOS" ;;
  esac

  case "$machine" in
    x86_64 | amd64) ARCH='x64' ;;
    aarch64 | arm64) ARCH='arm64' ;;
    *) die "unsupported architecture $(quote "$machine"): expected x86_64 or arm64" ;;
  esac

  if [ "$PLATFORM" = 'darwin' ] && [ "$UNIT_SCOPE" = 'system' ]; then
    die '--system writes a systemd unit, and macOS has no systemd; install for your user and hand the process to launchd'
  fi
}

# ---------------------------------------------------------------------------
# The toolchain
# ---------------------------------------------------------------------------

ensure_toolchain() {
  if [ "$PLATFORM" = 'darwin' ]; then
    # node-pty prebuilds cover macOS, so there is nothing to install. If the
    # prebuild is ever missing, `xcode-select --install` is the fix and npm's
    # own error will say so.
    report 'toolchain' 'not needed on macOS (node-pty ships a prebuild)'
    return 0
  fi

  if have python3 && have make && have_compiler; then
    report 'toolchain' 'present'
    return 0
  fi

  local manager packages
  if have apt-get; then
    manager='apt-get'
    packages="$TOOLCHAIN_APT"
  elif have dnf; then
    manager='dnf'
    packages="$TOOLCHAIN_DNF"
  elif have yum; then
    manager='yum'
    packages="$TOOLCHAIN_DNF"
  elif have apk; then
    manager='apk'
    packages="$TOOLCHAIN_APK"
  else
    die "no package manager this script knows (apt-get, dnf, yum, apk), and node-pty needs python3, make and a C++ compiler to compile on Linux. Install them, then run this again"
  fi

  report 'toolchain' "install $packages with $manager"
  [ "$DRY_RUN" = 'no' ] || return 0

  case "$manager" in
    apt-get)
      # shellcheck disable=SC2086
      escalate apt-get update
      # shellcheck disable=SC2086
      escalate apt-get install --no-install-recommends --yes $packages
      ;;
    dnf | yum)
      # shellcheck disable=SC2086
      escalate "$manager" install --assumeyes $packages
      ;;
    apk)
      # shellcheck disable=SC2086
      escalate apk add --no-cache $packages
      ;;
  esac
}

have_compiler() {
  have c++ || have g++ || have clang++
}

# Runs one command with whatever privilege this run has.
#
# sudo reads a password from the terminal and not from stdin, so a prompt here
# is safe under `curl | bash` -- see `run_setup`, where that distinction is the
# whole problem. With no terminal and no passwordless sudo there is nothing to
# prompt, so this says what to run instead of hanging.
escalate() {
  if [ "$(id -u)" = '0' ]; then
    "$@"
    return
  fi

  have sudo || die "this needs root and there is no sudo here. Run: $*"

  if sudo -n true 2>/dev/null; then
    sudo "$@"
    return
  fi

  have_terminal || die "this needs root, sudo wants a password, and there is no terminal to ask on. Run: sudo $*"
  say "asking sudo for: $*"
  sudo "$@"
}

# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

# Which Node this install will run on, and where it is.
#
# Adopt one that is already here, install one only when there is none. The same
# rule setup applies to providers, for the same reason: a second copy of a
# runtime installed in front of a working one is how a machine ends up running
# something other than what its operator thinks it runs.
#
# The prefix is looked at before PATH, and that ordering is what makes a second
# run an upgrade rather than a second download: the Node this script installed
# is not on anybody's PATH, so a PATH-first check would decide every time that
# there is no Node here.
#
# The answer is also the unit's, which is the whole reason this is resolved
# rather than merely done. A version manager keeps its Node in a directory a
# systemd unit has never heard of, so a service started with a minimal PATH
# would fail on the `#!/usr/bin/env node` line of the program it was pointed at
# -- the spec's opening problem, one level below the one it was written about.
resolve_node_directory() {
  if [ -x "$BIN_DIR/node" ] && node_major_is_recent "$BIN_DIR/node"; then
    NODE_ACTION='adopt'
    NODE_DIR="$BIN_DIR"
  elif have node && node_major_is_recent "$(command -v node)"; then
    NODE_ACTION='adopt'
    NODE_DIR="$(dirname "$(command -v node)")"
  else
    NODE_ACTION='install'
    NODE_DIR="$BIN_DIR"
  fi
}

ensure_node() {
  # Whatever the answer, it goes on this run's own PATH before anything else
  # happens.
  #
  # Every program this script starts from here down is a script whose first line
  # is `#!/usr/bin/env node` -- npm, and then agentplex itself. A Node unpacked
  # into the prefix is on nobody's PATH yet, so `$PREFIX/bin/npm` would resolve
  # `node` to whatever the machine had, which is the runtime this install exists
  # because of: too old, or absent, and in the first case it compiles a native
  # addon against the wrong one and says nothing. Captured here rather than
  # reasoned about -- an end-to-end run with a v20 shim ahead of PATH had npm's
  # shebang find the shim, print its version and exit 0, and the install then
  # reported success with no binary anywhere.
  export PATH="$BIN_DIR:$NODE_DIR:$PATH"

  if [ "$NODE_ACTION" = 'adopt' ]; then
    report 'node' "adopt $("$NODE_DIR/node" --version) from $NODE_DIR"
    return 0
  fi

  report 'node' "install the latest v${NODE_MAJOR}.x into $PREFIX"
  [ "$DRY_RUN" = 'no' ] || return 0

  local work sums file url expected
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  sums="$work/SHASUMS256.txt"
  fetch "$NODE_DIST_URL/SHASUMS256.txt" "$sums"

  # The checksum file names the release, so one fetch answers both "which
  # version is current" and "what should this archive hash to". .tar.gz and not
  # .tar.xz on purpose: a stock debian:bookworm-slim has tar and no xz, and an
  # installer that needs a package installed before it can install anything is
  # an installer with a second prerequisite nobody documented.
  file="$(awk -v suffix="-${PLATFORM}-${ARCH}.tar.gz" '$2 ~ suffix"$" { print $2 }' "$sums" | head -n 1)"
  [ -n "$file" ] || die "nothing at $NODE_DIST_URL builds for ${PLATFORM}-${ARCH}"
  expected="$(awk -v name="$file" '$2 == name { print $1 }' "$sums")"

  url="$NODE_DIST_URL/$file"
  say "downloading $file"
  fetch "$url" "$work/$file"
  verify_checksum "$work/$file" "$expected"

  # The Node tarball is laid out as a prefix -- bin/, include/, lib/, share/ --
  # so it unpacks straight into one, and the npm that arrives with it then
  # installs globally into the same tree. That is what makes a single directory
  # the whole of what this script owns and the whole of what an uninstall
  # removes.
  mkdir -p "$PREFIX"
  tar -xzf "$work/$file" -C "$PREFIX" --strip-components=1
  rm -rf "$work"
  trap - EXIT

  [ -x "$BIN_DIR/node" ] || die "unpacked Node but $BIN_DIR/node is not executable"
}

node_major_is_recent() {
  local version major
  version="$("$1" --version 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$NODE_MAJOR" ]
}

verify_checksum() {
  local path expected actual
  path="$1"
  expected="$2"
  if have sha256sum; then
    actual="$(sha256sum "$path" | awk '{ print $1 }')"
  elif have shasum; then
    actual="$(shasum -a 256 "$path" | awk '{ print $1 }')"
  else
    die 'no sha256sum or shasum here, so a downloaded runtime cannot be verified'
  fi
  [ "$actual" = "$expected" ] || die "checksum mismatch for $(basename "$path"): expected $expected, got $actual"
}

# Both downloaders carry the same floor: https only, TLS 1.2 or better. The
# fallback is the one a machine reaches without choosing it, so it is the one
# that must not quietly negotiate something weaker.
fetch() {
  local url destination
  url="$1"
  destination="$2"
  if have curl; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$destination" "$url"
  elif have wget; then
    wget -q --https-only --secure-protocol=TLSv1_2 -O "$destination" "$url"
  else
    die 'no curl and no wget, so there is nothing here that can download a runtime'
  fi
}

# ---------------------------------------------------------------------------
# The package
# ---------------------------------------------------------------------------

install_package() {
  report 'package' "$PACKAGE_SPEC into $PREFIX"
  [ "$DRY_RUN" = 'no' ] || return 0

  local npm
  npm="$(npm_command)"

  # --ignore-scripts=false rather than whatever the operator's npmrc says.
  # node-pty's install scripts are what compile the addon, and agentplex's
  # postinstall restores the executable bit the npm tarball drops from node-pty's
  # spawn-helper. An npmrc carrying ignore-scripts=true produces an install that
  # reports success and a service that cannot start, and our own postinstall
  # cannot warn about it because it is disabled by the same setting.
  "$npm" install --global --prefix "$PREFIX" --ignore-scripts=false "$PACKAGE_SPEC"

  [ -x "$BIN_DIR/$PACKAGE_NAME" ] || die "npm reported success and there is no $BIN_DIR/$PACKAGE_NAME"

  # The package this replaced, if the machine had it. Left in place it would
  # keep a second copy of every program on the disk and a stale `agentplexd`
  # on the PATH beside the new bin; npm's uninstall removes exactly what its
  # install put there and nothing of ours.
  if [ -x "$BIN_DIR/$OLD_PACKAGE_NAME" ]; then
    report 'upgrade' "remove the $OLD_PACKAGE_NAME package this replaces"
    "$npm" uninstall --global --prefix "$PREFIX" "$OLD_PACKAGE_NAME" || true
  fi

  # The prefix belongs to whoever runs the service, which for a user install is
  # already true and for a --system one has to be said. It is the prefix agentplex
  # *owns*: setup installs providers into it, as the service account, so a
  # root-owned tree here would turn the first provider install into a permission
  # error nobody would connect to this line.
  if [ "$UNIT_SCOPE" = 'system' ]; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
  fi
}

# The npm that belongs to the Node this run settled on, taken from beside it.
#
# A Node installed into the prefix is not on PATH yet, so `npm` there would be
# the machine's own -- an older one, or none at all -- compiling a native addon
# against a runtime this service refuses. Beside-it is right for an adopted Node
# too: whatever version manager put that node there put its npm in the same
# directory.
npm_command() {
  if [ -x "$NODE_DIR/npm" ]; then
    echo "$NODE_DIR/npm"
  elif have npm; then
    command -v npm
  else
    die 'there is a node here and no npm beside it, so there is nothing to install the package with'
  fi
}

# ---------------------------------------------------------------------------
# Configuration and the unit
# ---------------------------------------------------------------------------

# Written once, and never again.
#
# Everything in this file is a decision somebody made -- by hand, or through
# `agentplex setup` -- and an installer that rewrote it on every upgrade would
# undo them. So an existing file is left exactly as it is, and this says so
# rather than silently doing nothing.
write_environment_file() {
  if [ -e "$ENV_FILE" ]; then
    report 'settings' "$ENV_FILE (already there, left alone)"
    return 0
  fi

  report 'settings' "$ENV_FILE (create)"
  [ "$DRY_RUN" = 'no' ] || return 0

  mkdir -p "$(dirname "$ENV_FILE")"
  # 0600 before anything is written into it: the client token lives here, and a
  # file that is briefly world-readable is world-readable.
  ( umask 077 && cat >"$ENV_FILE" <<ENVIRONMENT
# agentplex settings, read by the systemd units as an EnvironmentFile. Both
# daemons read this one file, and each reads only the keys it needs.
#
# install.sh wrote this file once and will not touch it again. Two lines are
# uncommented because they are the two facts the installer had: the role you
# asked for, and the prefix it created. The rest is commented out because
# guessing a database path or a store path is worse than leaving one absent --
# fill them in, or let \`$PACKAGE_NAME setup\` do it.
#
# Every setting here has a flag as well, and the flag wins. The whole table is
# at $DOCS_URL

AGENTPLEX_ROLE=$ROLE

# Where agent binaries are looked for, ahead of the PATH this service inherits.
# A systemd unit gets a minimal PATH with no version-manager shims in it, so a
# \`claude\` that resolves in your shell does not resolve here; recording the
# directory is what makes that stop mattering. Separate several with ':'.
AGENTPLEX_BIN_PATH=$BIN_DIR

# The hub's half. Both are required for role=hub and role=both.
#AGENTPLEX_DATABASE_FILE=$STATE_DIR/hub.sqlite
#AGENTPLEX_CLIENT_TOKEN=

# The server beside the hub, for role=both: the hub pairs it at boot from the
# token in that identity file, so nobody types one. \`$PACKAGE_NAME setup\`
# fills these in.
#AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=$STATE_DIR/server.json
#AGENTPLEX_LOCAL_SERVER_PORT=8081

# The server's half. The identity file is required for role=server and
# role=both, and holds the pairing token; store paths are absolute and
# ':'-separated.
#AGENTPLEX_SERVER_IDENTITY_FILE=$STATE_DIR/server.json
#AGENTPLEX_STORE_PATH=

#AGENTPLEX_HOST=127.0.0.1
#AGENTPLEX_HUB_PORT=8080
#AGENTPLEX_SERVER_PORT=8081
#AGENTPLEX_LOG_LEVEL=info
ENVIRONMENT
  )

  if [ "$UNIT_SCOPE" = 'system' ]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  fi
}

# The unit file a daemon gets: agentplex-hub.service, agentplex-server.service.
unit_file() {
  echo "$UNIT_DIR/${PACKAGE_NAME}-$1.service"
}

# Whether this machine can hold a systemd unit at all. macOS has no systemd,
# and a container may have none.
can_write_units() {
  if [ "$PLATFORM" != 'linux' ]; then
    report 'unit' 'skipped: macOS has no systemd, hand the process to launchd'
    return 1
  fi
  if ! have systemctl; then
    report 'unit' 'skipped: no systemctl on this machine'
    return 1
  fi
  return 0
}

# The unit a pre-split install wrote, which started one program in every role.
#
# It is retired rather than left beside the new ones: two units starting the
# same daemons on one machine is two hubs on one database. What it decided is
# kept -- the settings file it read is the settings file the new units read --
# and its enablement is carried over, so a machine whose service came up at boot
# still does after the upgrade. This is the one place the installer enables a
# unit: a fresh install leaves its units for the operator, who has a client
# token to write first.
retire_old_unit() {
  can_write_units || return 0
  local old="$UNIT_DIR/${OLD_PACKAGE_NAME}.service"
  [ -e "$old" ] || return 0

  local ctl='systemctl --user'
  [ "$UNIT_SCOPE" = 'user' ] || ctl='systemctl'
  local was_enabled='no'
  if $ctl is-enabled --quiet "${OLD_PACKAGE_NAME}.service" 2>/dev/null; then
    was_enabled='yes'
  fi

  local daemon units=''
  for daemon in $DAEMONS; do
    units="$units ${PACKAGE_NAME}-${daemon}.service"
  done
  report 'upgrade' "retire $old and enable$units"
  [ "$DRY_RUN" = 'no' ] || return 0

  $ctl disable --now "${OLD_PACKAGE_NAME}.service" 2>/dev/null || true
  rm -f "$old"
  ENABLE_NEW_UNITS="$was_enabled"
}
ENABLE_NEW_UNITS='no'

write_units() {
  can_write_units || return 0
  local daemon file
  for daemon in $DAEMONS; do
    file="$(unit_file "$daemon")"
    if [ -e "$file" ]; then
      # Same argument as the settings file: a unit somebody edited is a decision,
      # and `--print-unit` shows what this version would have written, so an
      # operator can diff the two rather than have one silently replaced.
      report 'unit' "$file (already there, left alone; --print-unit shows this version)"
      continue
    fi
    report 'unit' "$file (write, not enabled)"
    [ "$DRY_RUN" = 'no' ] || continue
    mkdir -p "$UNIT_DIR"
    render_unit "$daemon" >"$file"
  done

  [ "$ENABLE_NEW_UNITS" = 'yes' ] || return 0
  local ctl='systemctl --user'
  [ "$UNIT_SCOPE" = 'user' ] || ctl='systemctl'
  $ctl daemon-reload || true
  for daemon in $DAEMONS; do
    $ctl enable --now "${PACKAGE_NAME}-${daemon}.service" || true
  done
}

# One unit, as text, from the paths this run resolved. Both daemons read the
# one settings file; each reads only the keys it needs, so a setting the other
# owns is not an error. Order does not matter: the hub dials the server and
# retries, so whichever comes up second is dialled when it is there.
#
# It is a here-doc and not a file beside this script on purpose: this script is
# fetched on its own over HTTPS and run, so anything it cannot carry inside
# itself is a second download and a second thing to get wrong.
render_unit() {
  local daemon="$1"
  local install_target='default.target'
  local identity=''
  if [ "$UNIT_SCOPE" = 'system' ]; then
    install_target='multi-user.target'
    identity="User=$SERVICE_USER
Group=$SERVICE_USER
"
  fi

  cat <<UNIT
[Unit]
Description=agentplex $daemon
Documentation=$DOCS_URL
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${identity}WorkingDirectory=$STATE_DIR
EnvironmentFile=$ENV_FILE
# The prefix goes first, and the directory holding the node this install
# settled on comes with it when that is somewhere a service would never look --
# a version manager's shims, say -- because ExecStart is a script whose first
# line is #!/usr/bin/env node. In front of the rest of the machine rather than
# instead of it: a session is not only the agent, it shells out to git, rg and
# whatever else the project needs.
Environment=PATH=$(unit_search_path)
ExecStart=$BIN_DIR/$PACKAGE_NAME $daemon
Restart=on-failure
RestartSec=5s
# Exit 2 is the daemon saying the configuration is wrong. Restarting will not
# help and the operator has to act, so the unit stops instead of hiding the
# message in a restart loop.
RestartPreventExitStatus=2
# SIGTERM is the default and the signal main.ts shuts down on. Twenty seconds is
# for the sessions: a server closes its pty children on the way out.
TimeoutStopSec=20s

# There is deliberately no sandboxing here -- no ProtectHome, no
# ProtectSystem=strict, no NoNewPrivileges. This service's job is to run a
# developer's own tooling as that developer, against their home directory and
# their checkouts, and every one of those directives turns that job into a
# failure that reads like a bug in the agent. The isolation that matters is the
# account this runs as, and that is settled by where this unit lives: a user
# unit runs as its user, and the system unit carries User=.

[Install]
WantedBy=$install_target
UNIT
}

# What the unit's PATH is, in order.
#
# The prefix, then the Node directory when it is neither the prefix nor
# somewhere a service already searches, then the machine. The middle case is the
# only interesting one and it is the common one on a developer's box: an adopted
# Node under ~/.nvm or ~/.local/share/fnm is invisible to systemd, and naming it
# here is what stops that from being a service that will not start.
unit_search_path() {
  local standard='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  local path="$BIN_DIR"

  if [ "$NODE_DIR" != "$BIN_DIR" ]; then
    case ":$standard:" in
      *":$NODE_DIR:"*) ;;
      *) path="$path:$NODE_DIR" ;;
    esac
  fi

  printf '%s:%s' "$path" "$standard"
}

# The dedicated account for the fleet case, where there is no human user to be.
ensure_service_account() {
  [ "$UNIT_SCOPE" = 'system' ] || return 0

  if id "$SERVICE_USER" >/dev/null 2>&1; then
    report 'account' "$SERVICE_USER (already there)"
    return 0
  fi

  report 'account' "create $SERVICE_USER, with $STATE_DIR as its home"
  [ "$DRY_RUN" = 'no' ] || return 0

  have useradd || die "no useradd here, so the $SERVICE_USER service account cannot be created"
  # A system account with a real home under /var/lib: the sessions it runs keep
  # a provider's state directory somewhere, and an account with no home has
  # nowhere to put one. No password is set, so nobody logs into it.
  useradd --system --create-home --home-dir "$STATE_DIR" --shell /bin/sh "$SERVICE_USER"
  install --directory --owner="$SERVICE_USER" --group="$SERVICE_USER" --mode=0755 "$STATE_DIR"
}

# ---------------------------------------------------------------------------
# Handing over to setup
# ---------------------------------------------------------------------------

# The last step, and the one with a trap in it.
#
# Under `curl | bash` this script *is* bash's stdin, and a child that reads
# stdin eats the script. Captured, running `cat install.sh | bash` against a
# script whose next lines were a tty check: the `read` returned the text of the
# following line, and bash then carried on from the line after that -- the check
# never ran, and nothing anywhere reported a problem. An interactive wizard on
# that stdin would consume the rest of this file.
#
# So setup gets /dev/tty explicitly, and when there is no terminal to give it --
# a cloud-init run, a Dockerfile, a CI step -- setup is not started at all and
# the command to run later is printed instead. Not started rather than started
# and hoped for: a wizard with no terminal either blocks forever or reads the
# installer that spawned it.
run_setup() {
  if [ "$RUN_SETUP" = 'no' ]; then
    if [ "$UNIT_SCOPE" = 'system' ]; then
      report 'setup' "not run: --system machines take a plan, replayed as $SERVICE_USER"
    else
      report 'setup' 'not run: --no-setup'
    fi
    return 0
  fi

  if ! have_terminal; then
    report 'setup' 'not run: no terminal to run a wizard on'
    return 0
  fi

  if [ "$DRY_RUN" = 'yes' ]; then
    report 'setup' "would run $BIN_DIR/$PACKAGE_NAME setup --role=$ROLE"
    return 0
  fi

  report 'setup' "$BIN_DIR/$PACKAGE_NAME setup --role=$ROLE"
  say ''

  local status='0'
  "$BIN_DIR/$PACKAGE_NAME" setup --role="$ROLE" </dev/tty || status="$?"

  if [ "$status" != '0' ]; then
    say ''
    say "setup exited $status. ${PACKAGE_NAME} is installed at $BIN_DIR/$PACKAGE_NAME and nothing about"
    say "this machine is half-done: run the setup again when you have dealt with what it said,"
    say "or configure $ENV_FILE by hand."
    exit "$status"
  fi
}

# Whether there is a terminal this run can hand to a child.
#
# Opening it, not testing it. `[ -r /dev/tty ]` answers yes in a container with
# no controlling terminal, where the open then fails with ENXIO -- captured on
# a machine where the test passed and `exec 3</dev/tty` printed
# "No such device or address".
have_terminal() {
  (exec 3</dev/tty) 2>/dev/null
}

# ---------------------------------------------------------------------------
# What happened
# ---------------------------------------------------------------------------

summary() {
  say ''
  if [ "$DRY_RUN" = 'yes' ]; then
    say 'dry run: nothing above was done.'
    return 0
  fi

  say "$PACKAGE_NAME is at $BIN_DIR/$PACKAGE_NAME"

  case ":${ORIGINAL_PATH}:" in
    *":$BIN_DIR:"*) ;;
    *)
      say ''
      say "$BIN_DIR is not on your PATH. To type ${PACKAGE_NAME} rather than its full path:"
      say "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac

  local units='' daemon
  for daemon in $DAEMONS; do
    [ -e "$(unit_file "$daemon")" ] && units="$units ${PACKAGE_NAME}-$daemon"
  done
  if [ -n "$units" ] && [ "$ENABLE_NEW_UNITS" = 'no' ]; then
    say ''
    say 'The units are written and deliberately not started: there is no database file, no'
    say "client token and no store paths until $ENV_FILE has them."
    say 'When it does:'
    if [ "$UNIT_SCOPE" = 'system' ]; then
      say '  systemctl daemon-reload'
      say "  systemctl enable --now$units"
    else
      say '  systemctl --user daemon-reload'
      say "  systemctl --user enable --now$units"
      say "  loginctl enable-linger $SERVICE_USER   # so it runs when you are not logged in"
    fi
  fi

  say ''
  say "Check the machine with: $BIN_DIR/$PACKAGE_NAME doctor --role=$ROLE"
  say "Documentation: $DOCS_URL"
}

# ---------------------------------------------------------------------------
# Small things
# ---------------------------------------------------------------------------

# One line per step, in one shape, so that a dry run and a real run read the
# same and a test can assert on either.
report() {
  printf '%-10s %s\n' "$1" "$2"
}

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

quote() {
  printf '"%s"' "$1"
}

main "$@"
