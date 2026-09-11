#!/usr/bin/env bash
#
# The agentplex bootstrap.
#
#   curl -fsSL <url> | bash                              # role=both, then setup
#   curl -fsSL <url> | bash -s -- --role=server          # server only
#   curl -fsSL <url> | bash -s -- --role=hub@1.3.0       # hub only, pinned
#   curl -fsSL <url> | bash -s -- --role=hub@1.3.0 --role=server@1.4.0
#   curl -fsSL <url> | bash -s -- --no-setup             # stop after the binary lands
#   curl -fsSL <url> | bash -s -- --uninstall            # take the runtime back off
#
# Deliberately ignorant. It ensures a Node runtime and the build toolchain,
# installs the published packages the role needs, writes the systemd units it
# does not start -- one per daemon the role runs, both for --role=both -- and
# hands over to `agentplex setup`. It knows nothing about providers, stores or
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
# AGENTPLEX_ROLE is the role and never the version pins that may have come with
# it. A role is a property of the machine -- it is what the machine is for, and
# it is still true a year later. A pin is a choice somebody made on one
# afternoon, and a machine reinstalled from this file has to come back as the
# same machine rather than at the versions that happened to be current then.
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
# same bytes. The value below satisfies all three -- the repository is public,
# GitHub serves raw content over TLS, and the major is a path component.
#
# `v1` is a branch of this repository rather than a tag, and
# `.github/workflows/release.yml` is what puts a script on it: its `v1` job
# fast-forwards `refs/heads/v1` to the released commit, after the publish
# succeeded and only for a `1.` version that is not a prerelease. So the
# one-liner hands out the installer from a release somebody can actually
# install, and a release candidate does not become what every new machine runs.
# A branch rather than a tag because the command a reader copies has to keep
# meaning the current 1.x installer: a tag in the path would freeze whoever
# copied it on the release they happened to read about, and the fast-forward is
# what makes the same string keep working.
#
# The `v1` here and INSTALL_SH_VERSION above are the same number on purpose,
# and the second path that comment names is a `v2` branch: a change that breaks
# a documented invocation gets a branch of its own rather than an edit to this
# one, so a command written today keeps fetching a script it still works with.
#
# A short alias in front of it (get.<domain>/v1/install.sh) is still deferred,
# and it is deferred on a registration rather than on a decision. No
# unregistered domain is printed anywhere in this repository as a command to
# run: publishing `curl | bash` against a name nobody has registered is an
# invitation for somebody else to register it, and the day that happens the
# instruction still looks exactly right. Deferring it costs a reader nothing --
# the URL below is long, but it resolves -- and the alias, when the name is
# registered, redirects to this same path.
#
# `apps/cli/README.md` prints this string and a test holds the two
# together, so there is one place to change when the alias exists.
readonly INSTALL_SH_URL='https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh'

# Two names, because a package name and a command name are different things and
# this project's are not the same word.
#
# The unscoped `agentplex` on npm belongs to somebody else -- a placeholder
# published in 2026 by an unrelated maintainer -- so this project publishes
# under its own scope. `bin` maps a command name to a path, and nothing about
# that mapping has to match the package it arrives in, so the rename stops at
# the registry.
#
# NPM_PACKAGE is what `npm install` is handed and the directory npm then writes
# under `lib/node_modules`. PACKAGE_NAME is everything else: the binary in the
# prefix, the stem of the unit file names, and the word in every line an
# operator reads. Splitting them is the whole of this: passing the scoped name
# where the plain one belongs renames the units and the binary, which is a
# machine an upgrade no longer recognises.
readonly NPM_PACKAGE='@softiesolutions/agentplex'
readonly PACKAGE_NAME='agentplex'

# The other three, because the release is four packages and a machine installs
# only what its role runs.
#
# The command above goes on every machine: `setup` configures one and `doctor`
# checks one, whatever it runs. Each daemon is a package of its own, and the
# client is a package of its own beside the hub -- so a hub machine carries no
# server code, and nothing it installs can fail for want of a C++ compiler. The
# hub package and the client reach node-pty nowhere at all, and the command
# declares it optional, which npm is allowed to skip. node-pty is the native
# addon with no Linux prebuild and the one thing here that needs a compiler; a
# server is the only role with a package that requires it.
#
# `web` is not a role. It is part of being a hub: the hub finds the client by
# resolving this name, and installs the two as siblings under
# lib/node_modules.
readonly NPM_PACKAGE_HUB='@softiesolutions/agentplex-hub'
readonly NPM_PACKAGE_SERVER='@softiesolutions/agentplex-server'
readonly NPM_PACKAGE_WEB='@softiesolutions/agentplex-web'

# The scope all four are published under, which is the one directory npm makes
# under lib/node_modules for the lot of them.
readonly NPM_SCOPE='@softiesolutions'

# ---------------------------------------------------------------------------
# Where the packages come from
# ---------------------------------------------------------------------------

# Nothing this project builds is published to a registry, and that is a decision
# rather than a gap.
#
# Each component has its own release train -- a CLI fix must stop forcing every
# server on the fleet to recompile a native addon -- and a release is a GitHub
# Release carrying one tarball. npm is still what installs it: `npm install
# <https tarball url>` unpacks the tarball and then resolves that tarball's own
# registry dependencies from npm in the ordinary way. Verified rather than
# assumed. So npm is used on this machine, and nothing of ours is published
# there.
#
# The asset name in that URL is a constant, per component, for ever. GitHub's
# `releases/latest/download/<asset>` redirect substitutes the tag and copies the
# file name through verbatim, so a version in the name is a name no unpinned URL
# could ever be written against; `npm pack` produces the version-stamped name
# and the release workflow renames it on the way up. That redirect is not what
# this script resolves through -- see VERSIONS_URL -- but the constant is what
# makes a URL buildable from a component and a version at all.
readonly RELEASE_DOWNLOAD_URL='https://github.com/SoftieSolutions/agentplex/releases/download'

# What is current, for every component at once.
#
# With one release train, `releases/latest/download/` answered "the current
# one". With four it cannot: GitHub's "latest" is the most recently published
# release *overall*, so on a day the server was released it would hand out the
# server's tag to a machine asking about the CLI. There is no per-component
# redirect, and the API call that would answer it is neither unauthenticated nor
# one request.
#
# So the release publishes a manifest instead, on the same `v1` branch and
# through the same raw.githubusercontent.com mechanism that already serves this
# script, written by the same job that already advances that branch. One
# unauthenticated fetch of a few hundred bytes answers what is current for every
# component and whether the set agrees on a protocol -- before anything is
# downloaded, which is the whole point of asking.
#
# It is read off the network, so `versions_entry` parses it and can say no.
readonly VERSIONS_URL='https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/versions.json'

# Every component, which is not every role. `cli` goes on every machine because
# `setup` and `doctor` do; `web` comes with every hub because a hub without the
# client serves 503. Neither is something --role can name.
readonly COMPONENTS='cli hub server web'

# The exact version a pin may name.
#
# Exact, and that is forced rather than chosen. A pin names a release tag --
# `hub-v1.3.0` -- and a tag is a string that either exists or does not. There is
# no registry here to resolve `1.3` against and no per-version history to
# resolve it from, so accepting a range would mean either guessing which release
# was meant or building a URL that 404s partway through an install. Refusing it
# at the flag, with the tag grammar named, is the honest end of that.
readonly RELEASE_VERSION='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

# The Node major this service declares in `engines`. No `.npmrc` ships in the
# tarball -- engine-strict governs the workspace -- so a consumer's npm only
# warns about that field. This script is what enforces the major: it adopts or
# installs a runtime of it before npm is ever invoked.
readonly NODE_MAJOR='24'
readonly NODE_DIST_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"

# The version this script wrote the last time it unpacked a runtime, kept inside
# the runtime directory it unpacked. It carries two facts and both are needed:
# which release is installed, so a newer one can be noticed, and that this
# script is what installed it, so a Node an operator put there themselves is
# never replaced and never removed.
readonly NODE_STAMP='.agentplex-node-version'

# What node-gyp needs to build node-pty on Linux. node-pty ships prebuilt
# binaries for macOS and Windows only, so on Linux the addon is compiled at
# install time; without these the very first command of the very first install
# dies inside node-gyp with an error naming neither agentplex nor a compiler.
readonly TOOLCHAIN_APT='python3 make g++'
readonly TOOLCHAIN_DNF='python3 make gcc-c++'
readonly TOOLCHAIN_APK='python3 make g++'
# The half of the toolchain line a server always gets, whether the compiler was
# already here or had to be installed. node-pty is a required dependency of the
# server package, so npm fails the install at the compile rather than finishing
# without it -- the plan says so before the install proves it.
readonly TOOLCHAIN_NOTE='node-pty must build or npm fails this install'

# The fleet layout: a dedicated service account, a prefix under /opt, state
# under /var/lib and configuration under /etc, which is where an operator looks
# for each of those.
readonly SYSTEM_ACCOUNT='agentplex'
readonly SYSTEM_PREFIX='/opt/agentplex'
readonly SYSTEM_STATE_DIR='/var/lib/agentplex'
readonly SYSTEM_CONFIG_DIR='/etc/agentplex'
readonly SYSTEM_UNIT_DIR='/etc/systemd/system'

readonly DOCS_URL='https://github.com/SoftieSolutions/agentplex/blob/master/apps/cli/README.md'

# The PATH this script was started with, kept because the script changes its own
# further down. What the summary has to answer is whether the operator's shell
# will find `agentplex` tomorrow, and asking that of a PATH this run has
# already prepended the prefix to would answer yes every time.
readonly ORIGINAL_PATH="${PATH:-}"

# Options, and what the run resolved them to. Set once by the functions below
# and read everywhere else.
#
# ROLE is still one of hub, server and both, and it is derived rather than
# typed: --role is repeatable now, so `--role=hub --role=server` and
# `--role=both` are the same machine and have to record the same word. It is
# the word that goes into AGENTPLEX_ROLE and into the handover to `setup`.
ROLE='both'
RUN_SETUP='yes'
SYSTEM='no'
DRY_RUN='no'
PRINT_UNIT='no'
UNINSTALL='no'
PREFIX=''
BIN_DIR=''
ENV_FILE=''
UNIT_DIR=''
UNIT_SCOPE=''
# The components --role named, in the order they were named, and the pins that
# came with them as `<component>=<version>` pairs. Both set by add_role, and
# COMPONENT_PINS also by --package-version, which is the CLI's pin.
ROLE_COMPONENTS=''
COMPONENT_PINS=''
# The daemons this role runs, one unit each, and the components this role
# installs. Both set by resolve_role from ROLE_COMPONENTS.
DAEMONS=''
INSTALL_COMPONENTS=''
SERVICE_USER=''
STATE_DIR=''
# What npm is handed, one spec per component in INSTALL_COMPONENTS, and empty
# when a dry run could not resolve one. Set by resolve_release.
PACKAGE_SPECS=''
# The versions manifest as text, and where it was read from -- empty when it was
# not read at all, which is every run whose components are all pinned and every
# dry run that would have had to download it. Set by load_versions.
VERSIONS_TEXT=''
VERSIONS_SOURCE=''
# `<component>=<version>` and `<component>=<protocol>` for what this run would
# install. A component with no entry is one whose version this run has no way to
# know, which is a dry run that declined to download and nothing else.
COMPONENT_VERSIONS=''
COMPONENT_PROTOCOLS=''
PLATFORM=''
ARCH=''
# The directory the runtime tarball unpacks into whole, and the directory inside
# it (or elsewhere, for an adopted Node) that holds the executable.
NODE_HOME=''
NODE_DIR=''
NODE_ACTION=''
# The release recorded in NODE_HOME, and empty for every Node this script did
# not install.
NODE_INSTALLED_VERSION=''
# Why this machine can hold no systemd unit, and empty when it can hold one.
# Set by resolve_unit_support, read by the unit step and by the summary.
UNIT_SKIP_REASON=''

usage() {
  cat <<USAGE
agentplex install.sh ${INSTALL_SH_VERSION}

Usage: bash install.sh [options]

  --role=<hub|server|both>[@<version>]
                               which roles this machine runs (default: both).
                               Repeatable, and each may pin its own version;
                               \`both\` names two components, so it takes no @
  --no-setup                   stop once the binary lands; run setup yourself
  --system                     install under a dedicated service account (needs root)
  --package-version=<version>  pin the ${PACKAGE_NAME} command, which every role installs
  --prefix=<directory>         install somewhere other than the default prefix
  --dry-run                    print what this would do and change nothing
  --print-unit                 print the systemd units this would write, and stop
  --uninstall                  remove the units, the runtime and the package; keep the state
  --version                    print this script's own version, and stop
  --help                       this

  --role pre-seeds setup rather than replacing it. --no-setup is for a machine
  that will receive a plan file and run \`${PACKAGE_NAME} setup --plan\` itself.

  A version is exact -- 1.4.0, not 1.4 -- because it names the release tag
  <component>-v<version>. Anything left unpinned comes from ${VERSIONS_URL}

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
  resolve_unit_support
  say "agentplex install.sh ${INSTALL_SH_VERSION}"
  say ''

  if [ "$UNINSTALL" = 'yes' ]; then
    uninstall
    return 0
  fi

  # After the uninstall branch, because an uninstall is about what is on this
  # disk and has no business asking a network what is current -- and after
  # --print-unit returned above, for the same reason.
  resolve_release
  ensure_toolchain
  ensure_node
  # Before anything is written, because the environment file below is chowned to
  # this account and a chown to a user that does not exist yet stops the run
  # after the package has landed -- half an install, and the confusing half.
  ensure_service_account
  install_package
  grant_service_account_ownership
  write_environment_file
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
      --role=*) add_role "${1#*=}" ;;
      --package-version=*) set_pin 'cli' "${1#*=}" '--package-version=' ;;
      --prefix=*)
        PREFIX="${1#*=}"
        # An empty value is almost always an unset variable in the command that
        # produced it, and the default prefix is not what that command meant.
        # It matters most for --uninstall, where a flag that falls back to a
        # default is a removal nobody typed.
        [ -n "$PREFIX" ] || die '--prefix was given with nothing after it, which is usually an unset variable: name the directory, or leave the flag off to take the default'
        ;;
      --no-setup) RUN_SETUP='no' ;;
      --system) SYSTEM='yes' ;;
      --dry-run) DRY_RUN='yes' ;;
      --print-unit) PRINT_UNIT='yes' ;;
      --uninstall) UNINSTALL='yes' ;;
      --version)
        say "agentplex install.sh ${INSTALL_SH_VERSION}"
        exit 0
        ;;
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

  # The default, applied here rather than as an initial value, so that `both`
  # arrives through the one function that knows what `both` means.
  [ -n "$ROLE_COMPONENTS" ] || add_role 'both'
  resolve_role

  if [ "$UNINSTALL" = 'yes' ] && [ "$PRINT_UNIT" = 'yes' ]; then
    die '--uninstall removes the units and --print-unit prints them: ask for one or the other'
  fi

  validate_prefix
}

# One --role, which may be given more than once and may carry a pin.
#
#   --role=both                        hub and server, whatever is current
#   --role=hub@1.3.0 --role=server@1.4.0
#   --role=hub@1.3.0                   hub only, pinned
#
# Repeatable because the components have separate release trains now, and a
# machine running both may want them at different versions. `both` is kept
# because it is what most machines are and `--role=hub --role=server` is a worse
# way to say it.
#
# **`both` takes no `@`.** A version names one component and `both` names two,
# so there is no version `--role=both@1.2` could be naming: it is either two
# pins written once, which is a coincidence the grammar should not encourage, or
# a single version for two independent trains, which is the coupling this whole
# change exists to remove. Refusing it costs the caller one more flag and says
# what a pin is.
#
# **A repeated component stops the run.** Not last-wins: `--role=hub@1.3.0
# --role=hub@1.4.0` is two answers to one question, and a script that silently
# took the second would install a version nobody asked for twice. It is the same
# argument this script already makes about `--rle` -- installing the wrong thing
# because something was quietly dropped is worse than not installing.
#
# **`cli` and `web` are not roles.** The command goes on every machine because
# `setup` and `doctor` do, and the client is part of being a hub. Both are named
# in the refusal rather than falling through to "unknown role", because somebody
# typing `--role=web` has a reasonable idea and the wrong word for it.
add_role() {
  local value="$1" component pin='' pinned='no'

  case "$value" in
    *@*)
      component="${value%%@*}"
      pin="${value#*@}"
      pinned='yes'
      ;;
    *) component="$value" ;;
  esac

  case "$component" in
    hub | server) ;;
    both)
      [ "$pinned" = 'no' ] || die "--role=both names two components and a version names one: pin them separately, as --role=hub@<version> --role=server@<version>"
      add_role 'hub'
      add_role 'server'
      return 0
      ;;
    cli | web) die "$(quote "$component") is not a role: the ${PACKAGE_NAME} command goes on every machine whatever it runs, and the client is part of being a hub. Pin the command with --package-version=<version>" ;;
    *) die "unknown role $(quote "$component"): expected one of hub, server, both" ;;
  esac

  case " $ROLE_COMPONENTS " in
    *" $component "*) die "--role names $component twice: two answers to one question is a contradiction rather than a last-one-wins, so nothing was installed" ;;
  esac
  ROLE_COMPONENTS="${ROLE_COMPONENTS:+$ROLE_COMPONENTS }$component"

  [ "$pinned" = 'no' ] || set_pin "$component" "$pin" "--role=$component@"
}

# One component pinned to one released version.
#
# The flag is passed in so the refusal can print the thing that was typed. An
# empty value is almost always an unset variable in the command that produced
# it, which is the same argument --prefix makes: a pin that falls back to
# whatever is current is an install nobody asked for.
set_pin() {
  local component="$1" pin="$2" flag="$3"

  [ -n "$pin" ] || die "${flag} was given with nothing after it, which is usually an unset variable: name a version, as ${flag}1.4.0, or leave the pin off to take what is current"
  [[ "$pin" =~ $RELEASE_VERSION ]] || die "$(quote "$pin") is not a version this can install: a pin names the release tag ${component}-v<version>, so it is an exact <major>.<minor>.<patch> and not a range"

  case " $COMPONENT_PINS " in
    *" $component="*) die "$component is pinned twice, and two versions of one component is a contradiction rather than a last-one-wins" ;;
  esac
  COMPONENT_PINS="${COMPONENT_PINS:+$COMPONENT_PINS }$component=$pin"
}

# What the role decides, in one place: the word this machine records, the
# daemons that get a unit, and the components that get installed.
#
# The command is in every row because `setup` and `doctor` belong on every
# machine; the client is in every row a hub is in, because a hub with no client
# serves 503 and says so at startup.
resolve_role() {
  local has_hub='no' has_server='no' component
  for component in $ROLE_COMPONENTS; do
    case "$component" in
      hub) has_hub='yes' ;;
      server) has_server='yes' ;;
    esac
  done

  if [ "$has_hub" = 'yes' ] && [ "$has_server" = 'yes' ]; then
    ROLE='both'
    DAEMONS='hub server'
    INSTALL_COMPONENTS='cli hub web server'
  elif [ "$has_hub" = 'yes' ]; then
    ROLE='hub'
    DAEMONS='hub'
    INSTALL_COMPONENTS='cli hub web'
  else
    ROLE='server'
    DAEMONS='server'
    INSTALL_COMPONENTS='cli server'
  fi
}

# The published name, the stable asset name and the metadata beside it, for one
# component.
#
# Three cases rather than three strings built out of the component word. The
# names happen to end in the component's word today, and what a machine
# downloads is the wrong thing to have depend on that continuing to be true.
# `scripts/install.sh.integration.test.ts` reads the assembler's own table and
# holds these against it, so a rename there fails here rather than at a 404.
component_package() {
  case "$1" in
    cli) printf '%s' "$NPM_PACKAGE" ;;
    hub) printf '%s' "$NPM_PACKAGE_HUB" ;;
    server) printf '%s' "$NPM_PACKAGE_SERVER" ;;
    web) printf '%s' "$NPM_PACKAGE_WEB" ;;
    *) die "no package holds the $1 component" ;;
  esac
}

component_asset() {
  case "$1" in
    cli) printf 'agentplex.tgz' ;;
    hub) printf 'agentplex-hub.tgz' ;;
    server) printf 'agentplex-server.tgz' ;;
    web) printf 'agentplex-web.tgz' ;;
    *) die "no asset holds the $1 component" ;;
  esac
}

component_metadata_asset() {
  printf '%s.json' "$(basename "$(component_asset "$1")" .tgz)"
}

# One file published at one release tag.
release_url() {
  printf '%s/%s-v%s/%s' "$RELEASE_DOWNLOAD_URL" "$1" "$2" "$3"
}

# The value one of the `<component>=<value>` lists holds for a component, and
# nothing at all when it holds none. Empty is an answer here rather than a
# failure: an unpinned component has no pin, and a dry run that declined to
# download has no version.
lookup() {
  local pair
  for pair in $1; do
    case "$pair" in
      "$2"=*)
        printf '%s' "${pair#*=}"
        return 0
        ;;
    esac
  done
}

component_pin() { lookup "$COMPONENT_PINS" "$1"; }
component_version() { lookup "$COMPONENT_VERSIONS" "$1"; }
component_protocol() { lookup "$COMPONENT_PROTOCOLS" "$1"; }

# The shape a prefix has to have before anything is done with it.
#
# This runs for every invocation and not only for --uninstall, and that is the
# point rather than tidiness: --uninstall is a removal driven by a flag, and the
# way to keep a mistyped one from removing something else is for the install
# that created the directory to have refused the same spelling. A prefix this
# accepts is one --uninstall can be handed back.
#
# The refusals, and what each is for. Not absolute: a relative prefix resolves
# against whatever directory the run happened to start in, which for a piped
# install is nobody's decision. A `..` in it: the path a person read is not the
# path that would be removed. Top level: /usr and /opt are the machine's own
# directories, and this script creates, fills and empties the one it is given.
#
# A trailing slash is trimmed rather than refused -- it is a spelling and not a
# mistake -- but trimmed before anything is built out of it, so that the paths
# this prints and the paths it removes are the ones a reader can compare.
validate_prefix() {
  [ -n "$PREFIX" ] || return 0

  case "$PREFIX" in
    /*) ;;
    *) die "--prefix must be an absolute path, not $(quote "$PREFIX")" ;;
  esac

  case "/$PREFIX/" in
    *'/../'*) die "--prefix must name a directory outright, and $(quote "$PREFIX") walks through .." ;;
  esac

  while [ "$PREFIX" != '/' ] && [ "$PREFIX" != "${PREFIX%/}" ]; do
    PREFIX="${PREFIX%/}"
  done

  [ -n "${PREFIX%/*}" ] || die "--prefix must be at least two directories deep, and $(quote "$PREFIX") is not: this is the directory an install fills and --uninstall empties"
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
    ENV_FILE="$SYSTEM_CONFIG_DIR/agentplex.env"
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
    ENV_FILE="$PREFIX/agentplex.env"
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT_SCOPE='user'
  fi

  BIN_DIR="$PREFIX/bin"
  resolve_node_directory
}

# ---------------------------------------------------------------------------
# Which release this machine installs
# ---------------------------------------------------------------------------

# What npm is handed, one entry per component this role installs, and the one
# check made before anything is downloaded.
#
# Three sources, and only one of them is a release.
#
# **AGENTPLEX_PACKAGE** is the seam this repository's own container check
# installs through: a directory of packed tarballs from a build that has never
# been published. A directory rather than four variables, because four variables
# can be half set -- a machine that took a local hub beside a released command
# would be a green check of a build it had not installed. Nothing here is a
# release, so nothing is resolved and no protocol is checked, and this says so
# rather than implying a version it does not have.
#
# **A pin** names a release tag outright, so the URL is known without asking
# anything. What is not known is what that release speaks, which is why a pin
# costs one small extra download -- see `pinned_protocol`.
#
# **versions.json** answers everything else, in one unauthenticated fetch,
# before a byte of any tarball is downloaded.
resolve_release() {
  if [ -n "${AGENTPLEX_PACKAGE:-}" ]; then
    [ -d "$AGENTPLEX_PACKAGE" ] || die "AGENTPLEX_PACKAGE names $(quote "$AGENTPLEX_PACKAGE"), which is not a directory: it is the directory holding the packed tarballs to install, one per package"
    local component
    PACKAGE_SPECS=''
    for component in $INSTALL_COMPONENTS; do
      PACKAGE_SPECS="$PACKAGE_SPECS $(package_tarball "$(component_package "$component")")"
    done
    PACKAGE_SPECS="${PACKAGE_SPECS# }"
    report 'release' "the tarballs in $AGENTPLEX_PACKAGE; no version is resolved and no protocol is checked, because a directory of tarballs is one build and not a release"
    return 0
  fi

  load_versions
  resolve_component_versions
  check_protocol_agreement
  build_package_specs
  report_release
}

# The versions manifest, off the network or off a disk, and only when something
# is going to read it.
#
# Not fetched when every component this machine installs is pinned: the manifest
# describes what is current, and a run that asked for something else has nothing
# to learn from it.
#
# **A dry run downloads nothing**, which is the rule `ensure_node` already keeps
# about the Node release file, and for the same reason: "would install 1.4.0" is
# a claim a run that performed no download cannot make. So a dry run with
# nothing to read the manifest from names the components and says the question
# went unasked, rather than printing a version it guessed.
#
# AGENTPLEX_VERSIONS is what makes that testable and what an air-gapped mirror
# would use. It names a directory laid out as the release is: `versions.json` at
# its root, and `<component>-v<version>/<asset>.json` for each pinned release --
# the same paths, at the same names, one origin further down. Reading a local
# file is not a download, so a dry run reads it.
load_versions() {
  local component unpinned='no' file

  for component in $INSTALL_COMPONENTS; do
    [ -n "$(component_pin "$component")" ] || unpinned='yes'
  done
  [ "$unpinned" = 'yes' ] || return 0

  if [ -n "${AGENTPLEX_VERSIONS:-}" ]; then
    file="$AGENTPLEX_VERSIONS/versions.json"
    [ -f "$file" ] || die "AGENTPLEX_VERSIONS names $(quote "$AGENTPLEX_VERSIONS"), which holds no versions.json: it is the directory holding the metadata a release publishes"
    VERSIONS_TEXT="$(cat "$file")"
    VERSIONS_SOURCE="$file"
    return 0
  fi

  [ "$DRY_RUN" = 'no' ] || return 0

  file="$(mktemp)"
  if ! fetch "$VERSIONS_URL" "$file"; then
    rm -f "$file"
    die "could not reach $VERSIONS_URL, which is what says which version of each component is current. Pin every component with --role=<role>@<version> and --package-version=<version> to install without it"
  fi
  VERSIONS_TEXT="$(cat "$file")"
  rm -f "$file"
  VERSIONS_SOURCE="$VERSIONS_URL"
}

# A version and a protocol for every component this machine installs.
resolve_component_versions() {
  local component pin entry protocol
  COMPONENT_VERSIONS=''
  COMPONENT_PROTOCOLS=''

  for component in $INSTALL_COMPONENTS; do
    pin="$(component_pin "$component")"
    if [ -n "$pin" ]; then
      # Assigned and then passed, rather than substituted into the call. `die`
      # inside `$(...)` exits the subshell, and the exit status of a command
      # substitution used as an *argument* is thrown away -- so a pre-check that
      # failed would print its refusal and the install would carry on. Captured
      # here: a pin whose metadata was missing said so and then installed
      # anyway. An assignment is what makes `set -e` see it.
      protocol="$(pinned_protocol "$component" "$pin")"
      record_component "$component" "$pin" "$protocol"
      continue
    fi
    # Only a dry run reaches here with no manifest; a real run has already died
    # trying to fetch one.
    [ -n "$VERSIONS_SOURCE" ] || continue
    entry="$(versions_entry "$component")"
    record_component "$component" "${entry%% *}" "${entry##* }"
  done
}

record_component() {
  COMPONENT_VERSIONS="${COMPONENT_VERSIONS:+$COMPONENT_VERSIONS }$1=$2"
  [ -z "$3" ] || COMPONENT_PROTOCOLS="${COMPONENT_PROTOCOLS:+$COMPONENT_PROTOCOLS }$1=$3"
}

# What a pinned release speaks, read before anything is installed.
#
# This is the judgement call in the delivery grammar, so it is written down.
# `versions.json` only describes what is current, and a pin is by definition a
# request for something else -- so the only place a pinned release's protocol
# exists is at its own tag. The alternatives were to install first and check
# afterwards, or not to check a pinned component at all, and both of them end at
# the same machine: a hub and a server that are installed, running, and unable
# to pair, which is exactly the failure this whole grammar exists to prevent.
# Pre-checking costs one small extra artifact per release and one small extra
# download per pin, and it turns that machine into a refusal with both numbers
# named and nothing written.
#
# A dry run downloads nothing, so it leaves the protocol unknown rather than
# claiming one -- and `check_protocol_agreement` skips what it does not know
# instead of treating "unknown" as "agrees".
pinned_protocol() {
  local component="$1" version="$2" asset url file text protocol
  asset="$(component_metadata_asset "$component")"

  if [ -n "${AGENTPLEX_VERSIONS:-}" ]; then
    # Laid out as the release is -- a directory per tag, holding the asset at
    # the name it is published under -- rather than flattened to one file per
    # pin. A seam whose paths are shaped differently from the thing it stands in
    # for is a seam that agrees with the code and not with the world.
    file="$AGENTPLEX_VERSIONS/${component}-v${version}/${asset}"
    [ -f "$file" ] || die "AGENTPLEX_VERSIONS holds no ${component}-v${version}/${asset}, and $component is pinned to $version"
    release_protocol "$(cat "$file")" "$file" "$component"
    return 0
  fi

  [ "$DRY_RUN" = 'no' ] || return 0

  url="$(release_url "$component" "$version" "$asset")"
  file="$(mktemp)"
  if ! fetch "$url" "$file"; then
    rm -f "$file"
    die "nothing is published at $url, so there is no ${component}-v${version} release to install -- or it predates the metadata every release now publishes beside its tarball"
  fi
  # Read, then removed, then parsed: the parse is what can die, and a file left
  # in /tmp by every refusal is litter this run has no trap to sweep up.
  text="$(cat "$file")"
  rm -f "$file"
  protocol="$(release_protocol "$text" "$url" "$component")"
  printf '%s' "$protocol"
}

# Every component this machine would install, speaking one protocol.
#
# A tripwire and not a resolver, and the difference is the whole design. A
# protocol change releases every affected component together, so the entries in
# `versions.json` always agree; if they ever do not, that is a release process
# that broke rather than a choice this script should be making. Working out "the
# newest set of versions that happens to agree" would need per-version history
# this has no way to read, one request per candidate, and it would quietly paper
# over exactly the mistake the tripwire is there to report.
#
# Asked of the components this machine installs and not of the whole manifest. A
# hub install refused because the `server` entry disagrees would be refusing over
# a package this machine will never download.
check_protocol_agreement() {
  local component protocol first='' first_component=''

  for component in $INSTALL_COMPONENTS; do
    protocol="$(component_protocol "$component")"
    [ -n "$protocol" ] || continue
    if [ -z "$first" ]; then
      first="$protocol"
      first_component="$component"
      continue
    fi
    [ "$protocol" = "$first" ] || die "this machine would install a $first_component speaking protocol $first and a $component speaking protocol $protocol, and two components that disagree about the protocol do not talk to each other. A protocol change releases every affected component together, so this is a broken release rather than a choice to make: nothing has been installed"
  done
}

# The URL for each component, or nothing at all.
#
# All or none: a plan that named three URLs and left the fourth as a shrug would
# be handed to npm as three packages, and a machine missing one of them is the
# half-installed machine every check above exists to prevent.
build_package_specs() {
  local component version
  PACKAGE_SPECS=''

  for component in $INSTALL_COMPONENTS; do
    version="$(component_version "$component")"
    if [ -z "$version" ]; then
      PACKAGE_SPECS=''
      return 0
    fi
    PACKAGE_SPECS="$PACKAGE_SPECS $(release_url "$component" "$version" "$(component_asset "$component")")"
  done
  PACKAGE_SPECS="${PACKAGE_SPECS# }"
}

# The versions, the protocol they agree on, and where each of those came from.
#
# One line, and it says what it does not know. A component with no version is a
# dry run that declined to download; a set with no protocol is the same run,
# or every component pinned on a machine that could not be asked.
report_release() {
  local component line='' protocol='' version

  for component in $INSTALL_COMPONENTS; do
    version="$(component_version "$component")"
    line="${line:+$line, }$component ${version:-(not resolved)}"
    [ -n "$protocol" ] || protocol="$(component_protocol "$component")"
  done

  if [ -n "$VERSIONS_SOURCE" ]; then
    line="$line (from $VERSIONS_SOURCE)"
  elif [ -z "$PACKAGE_SPECS" ]; then
    line="$line: a dry run downloads nothing, and $VERSIONS_URL is a download"
  else
    line="$line (every component pinned, so $VERSIONS_URL was not read)"
  fi

  report 'release' "$line"
  if [ -n "$protocol" ]; then
    report 'protocol' "$protocol, which every component above agrees on"
  else
    report 'protocol' "not checked: a dry run downloads nothing, and the protocol of a release is published with it"
  fi
}

# ---------------------------------------------------------------------------
# Reading the JSON a release publishes
# ---------------------------------------------------------------------------
#
# Two files, both small, both written by the release workflow out of the
# assembled manifests, and both read off the network:
#
#   versions.json   {"cli":{"version":"1.4.0","protocol":3}, ...}
#   <component>-v<version>.json
#                   {"component":"hub","version":"1.2.0","protocol":3}
#
# Parsed and not read. Every one of them is a claim out of another program, and
# the whole reason this script fetches them before it downloads anything is so
# that a bad one costs a refusal rather than a half-installed machine. There is
# no jq on a stock debian:bookworm-slim and no node either -- this runs before
# `ensure_node` has put one there -- so the parser is bash, and it is written as
# a grammar that refuses rather than as an extractor that guesses: a field that
# is not there, a version that is not a version and a protocol that is not a
# number each stop the run naming the file.
#
# Whitespace is deleted outright rather than skipped over, which is what makes
# the field patterns below one-liners. Nothing these files hold can contain a
# space: a component is one of four words, a version is a semver and a protocol
# is an integer, and anything that did contain one would fail the checks that
# follow rather than slip through reshaped.

flatten_json() {
  printf '%s' "$1" | tr -d ' \t\n\r'
}

# The value of one string field of a flat JSON object, or a non-zero.
json_string() {
  local text="$1" key="$2" value
  case "$text" in
    *"\"$key\":\""*) ;;
    *) return 1 ;;
  esac
  value="${text#*\""$key"\":\"}"
  printf '%s' "${value%%\"*}"
}

# The value of one integer field of a flat JSON object, or a non-zero. A field
# whose value is quoted, negative or absent all fail here rather than later.
json_number() {
  local text="$1" key="$2" value
  case "$text" in
    *"\"$key\":"*) ;;
    *) return 1 ;;
  esac
  value="${text#*\""$key"\":}"
  value="${value%%,*}"
  value="${value%%\}*}"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$value"
}

# One component's entry out of the versions manifest, as `<version> <protocol>`.
#
# A component this run needs and the manifest does not name is a refusal and not
# a fallback to anything: the manifest is what says which version is current,
# and a machine that carried on would install three quarters of a set.
versions_entry() {
  local component="$1" flat entry version protocol

  flat="$(flatten_json "$VERSIONS_TEXT")"
  case "$flat" in
    '{'*'}') ;;
    *) die "$VERSIONS_SOURCE is not a versions manifest: it holds no JSON object" ;;
  esac

  case "$flat" in
    *"\"$component\":{"*) ;;
    *) die "$VERSIONS_SOURCE names no $component, and this machine installs one. It is the manifest of what is current for every component, so a missing entry is a release that did not finish rather than something to guess at" ;;
  esac
  entry="${flat#*\""$component"\":\{}"
  entry="${entry%%\}*}"

  version="$(json_string "$entry" 'version')" || die "$VERSIONS_SOURCE gives $component no version"
  [[ "$version" =~ $RELEASE_VERSION ]] || die "$VERSIONS_SOURCE gives $component the version $(quote "$version"), which is not a version this can install"
  protocol="$(json_number "$entry" 'protocol')" || die "$VERSIONS_SOURCE gives $component no protocol number, and the protocol is what says whether the components on this machine can talk to each other"

  printf '%s %s' "$version" "$protocol"
}

# The protocol out of the metadata published beside one release's tarball.
#
# The component is checked as well as read: an asset served from the wrong tag
# -- a redirect followed somewhere unexpected, a release edited by hand -- is a
# file that parses perfectly and describes something else.
release_protocol() {
  local flat component protocol
  flat="$(flatten_json "$1")"

  component="$(json_string "$flat" 'component')" || die "$2 is not release metadata: it names no component"
  [ "$component" = "$3" ] || die "$2 describes the $component component and this machine is asking about $3"
  protocol="$(json_number "$flat" 'protocol')" || die "$2 states no protocol number for $3"

  printf '%s' "$protocol"
}

# The tarball in that directory that holds one package.
#
# npm names a pack after the package with the scope flattened -- the `@` goes
# and the `/` becomes a `-` -- followed by `-<version>.tgz`. That version is
# what makes this unambiguous and is the reason for the `[0-9]` in the pattern:
# `softiesolutions-agentplex-*.tgz` matches the hub, the server and the client
# as well as the command, and a glob that matched four files where one was
# wanted is how the old single-tarball line would have broken silently here.
package_tarball() {
  local flat file base
  flat="${1#@}"
  flat="${flat//\//-}"

  for file in "$AGENTPLEX_PACKAGE"/*.tgz; do
    [ -e "$file" ] || continue
    base="$(basename "$file" .tgz)"
    case "$base" in
      "$flat"-[0-9]*)
        printf '%s' "$file"
        return 0
        ;;
    esac
  done

  die "no ${flat}-<version>.tgz in $AGENTPLEX_PACKAGE, and --role=$ROLE installs $1. A directory missing one of the packages a role needs would install the rest and quietly leave that one to a registry"
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

# Whether this role runs a server, asked of $DAEMONS rather than of $ROLE.
#
# $DAEMONS is the role already resolved into what will actually be started on
# this machine, and re-deriving the same fact from $ROLE a second time is how
# the two answers end up disagreeing the day a fourth role is added.
runs_a_server() {
  case " $DAEMONS " in
    *' server '*) return 0 ;;
    *) return 1 ;;
  esac
}

# What node-pty costs, and who pays it.
#
# The compiler is here for node-pty and for nothing else. node-pty ships no
# Linux prebuild, so npm compiles it from source, and node-gyp needs python3,
# make and a C++ compiler -- none of which a stock debian:bookworm-slim has.
#
# Only a server opens a pseudoterminal, and the packaging is what makes that a
# fact about the machine rather than a hope. The hub package and the client
# reach node-pty nowhere, and the command -- which every role installs, for
# `setup` and `doctor` -- declares it optional. So no package a hub installs can
# fail for want of a compiler: npm builds node-pty for the command where there
# is one and skips it where there is not, and either way the hub runs.
#
# For a server it is still required, and now in the strongest sense: node-pty is
# a *required* dependency of the server package, so an npm that cannot compile
# it fails the install itself, at the compile, with node-gyp's own error. That
# is what retired AGENTPLEX_REQUIRE_PTY. The variable existed because node-pty
# was optional in one tarball every machine installed and npm exits 0 when an
# optional build fails, so a server could report a clean install and then fail
# to open a session; the postinstall read the variable and turned that back into
# a failure. There is no longer a machine where that can happen, so the variable
# is gone rather than left standing with nothing to do.
ensure_toolchain() {
  if ! runs_a_server; then
    report 'toolchain' 'not needed: a hub opens no pseudoterminal, and no package it installs carries node-pty'
    return 0
  fi

  if [ "$PLATFORM" = 'darwin' ]; then
    # node-pty prebuilds cover macOS, so there is nothing to install. If the
    # prebuild is ever missing, `xcode-select --install` is the fix and npm's
    # own error will say so.
    report 'toolchain' 'not needed on macOS (node-pty ships a prebuild)'
    return 0
  fi

  if have python3 && have make && have_compiler; then
    report 'toolchain' "present; $TOOLCHAIN_NOTE"
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

  report 'toolchain' "install $packages with $manager; $TOOLCHAIN_NOTE"
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
# What it looks at inside the prefix is $PREFIX/node, a directory that holds the
# runtime and nothing else. "Already here" and "already here and current" are
# then two different questions, and the second one has somewhere to keep its
# answer: `ensure_node` re-reads what `latest-v<major>.x` names and replaces a
# release that has been superseded, which a machine that adopted 24.0.0 two
# years ago never used to get.
#
# The answer is also the unit's, which is the whole reason this is resolved
# rather than merely done -- and it is now the unit's literally: ExecStart names
# "$NODE_DIR/node", so whatever this function decides is the interpreter systemd
# starts. That used to be an indirect claim, through a PATH the unit set so that
# a `#!/usr/bin/env node` line could find something; the failure it was written
# about was a version manager keeping its Node somewhere systemd has never heard
# of. Naming the answer instead of arranging for it to be found is the same
# decision reaching further, and the wrong answer here is now visibly wrong
# rather than a service that dies looking for an interpreter.
resolve_node_directory() {
  NODE_HOME="$PREFIX/node"

  if [ -x "$NODE_HOME/bin/node" ] && node_major_is_recent "$NODE_HOME/bin/node"; then
    NODE_DIR="$NODE_HOME/bin"
    NODE_INSTALLED_VERSION="$(node_recorded_version)"
    # The record is what makes a runtime this script's, and the directory is
    # not. A Node an operator unpacked under this prefix themselves is their
    # decision, and the paragraph above is as much an argument against
    # overwriting a working runtime as against installing in front of one.
    if [ -n "$NODE_INSTALLED_VERSION" ]; then
      NODE_ACTION='refresh'
    else
      NODE_ACTION='adopt'
    fi
  elif have node && node_major_is_recent "$(command -v node)"; then
    NODE_ACTION='adopt'
    NODE_DIR="$(dirname "$(command -v node)")"
  else
    NODE_ACTION='install'
    NODE_DIR="$NODE_HOME/bin"
  fi
}

# The release this script last unpacked into NODE_HOME, or nothing at all.
#
# Parsed and not read: the file is a word off a disk and a claim like any other.
# A line this refuses costs one unnecessary download and nothing else, which is
# the cheaper of the two ways to be wrong about it.
node_recorded_version() {
  local recorded
  [ -f "$NODE_HOME/$NODE_STAMP" ] || return 0
  recorded="$(head -n 1 "$NODE_HOME/$NODE_STAMP" 2>/dev/null || true)"
  case "$recorded" in
    v[0-9]*.[0-9]*.[0-9]*) printf '%s' "$recorded" ;;
  esac
}

# `node-v24.9.0-linux-x64.tar.gz` -> `v24.9.0`, which is the string
# `node --version` prints, so the two compare without either being reshaped.
node_version_of() {
  local name="${1#node-}"
  printf '%s' "${name%%-*}"
}

# The checksum file for `latest-v<major>.x`, into $1, or a non-zero this run can
# carry on from.
#
# `fetch` dies when there is nothing here that can download at all, which is the
# right answer for a machine with no runtime and the wrong one for a machine
# that already has ours -- so the downloader is asked about first and a machine
# with neither reads as "could not check" rather than as a dead install.
node_release_sums() {
  have curl || have wget || return 1
  fetch "$NODE_DIST_URL/SHASUMS256.txt" "$1"
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

  if [ "$DRY_RUN" = 'yes' ]; then
    # What a dry run can say about the refresh is the whole of what it can say.
    # Which release `latest-v<major>.x` names lives in a file on nodejs.org, and
    # reading it is a download -- so the plan names the runtime that is here and
    # states that the question went unasked. "Would keep" and "would replace"
    # are both claims this run has no way to make.
    if [ "$NODE_ACTION" = 'refresh' ]; then
      report 'node' "keep or replace $NODE_INSTALLED_VERSION in $NODE_HOME, whichever $NODE_DIST_URL names (not checked: a dry run downloads nothing, and the answer is a download)"
    else
      report 'node' "install the latest v${NODE_MAJOR}.x into $NODE_HOME"
    fi
    return 0
  fi

  local work sums file expected version
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work' '$NODE_HOME.new'" EXIT

  sums="$work/SHASUMS256.txt"
  if ! node_release_sums "$sums"; then
    if [ "$NODE_ACTION" = 'refresh' ]; then
      # Degrade in the direction that does not over-claim. The runtime here is
      # the one that was here, and whether a newer one exists is unknown rather
      # than no -- so the line says unknown. Failing the install over a check
      # that could not be made would be the worse answer: the machine has a
      # runtime of the right major, which is all the install actually needs.
      report 'node' "keep $NODE_INSTALLED_VERSION in $NODE_HOME: $NODE_DIST_URL could not be reached, so whether a newer v${NODE_MAJOR}.x exists is unknown"
      rm -rf "$work"
      trap - EXIT
      return 0
    fi
    die "could not reach $NODE_DIST_URL, and there is no Node of v${NODE_MAJOR} or better here to fall back on"
  fi

  # The checksum file names the release, so one fetch answers all three of which
  # version is current, whether that is the one already here, and what the
  # archive should hash to. .tar.gz and not .tar.xz on purpose: a stock
  # debian:bookworm-slim has tar and no xz, and an installer that needs a
  # package installed before it can install anything is an installer with a
  # second prerequisite nobody documented.
  file="$(awk -v suffix="-${PLATFORM}-${ARCH}.tar.gz" '$2 ~ suffix"$" { print $2 }' "$sums" | head -n 1)"
  [ -n "$file" ] || die "nothing at $NODE_DIST_URL builds for ${PLATFORM}-${ARCH}"
  expected="$(awk -v name="$file" '$2 == name { print $1 }' "$sums")"
  version="$(node_version_of "$file")"

  if [ "$NODE_ACTION" = 'refresh' ]; then
    if [ "$version" = "$NODE_INSTALLED_VERSION" ]; then
      report 'node' "keep $NODE_INSTALLED_VERSION in $NODE_HOME, which is what $NODE_DIST_URL names"
      rm -rf "$work"
      trap - EXIT
      return 0
    fi
    # The whole reason the record exists. A machine that adopted 24.0.0 two
    # years ago used to keep it through every reinstall, security releases
    # included, because "a Node of the right major is here" was the only
    # question anybody asked.
    report 'node' "replace $NODE_INSTALLED_VERSION in $NODE_HOME with $version"
  else
    report 'node' "install $version into $NODE_HOME"
  fi

  say "downloading $file"
  fetch "$NODE_DIST_URL/$file" "$work/$file"
  verify_checksum "$work/$file" "$expected"

  # The tarball is laid out as a prefix -- bin/, include/, lib/, share/ -- so it
  # unpacks whole into one directory of its own. That directory is not $PREFIX:
  # npm still installs globally into $PREFIX, and the prefix root also holds the
  # settings file, the server identity and, for --system, the hub database. A
  # runtime spread over those is a directory with two lifetimes in it, and
  # neither "what did this install put here" nor "what is safe to delete" has an
  # answer while they share one.
  #
  # Unpacked beside the old runtime and moved into place rather than over it.
  # The archive is verified by the time this line runs, so a failure here is a
  # full disk or a signal -- and the window where this machine has no runtime at
  # all should be a rename rather than an unpack.
  #
  # --no-same-owner because the archive carries an owner and tar run by root
  # honours it by default. Every entry in a nodejs.org tarball is `iojs:iojs`,
  # the account on the release builder, and no machine this runs on has that
  # name -- so tar falls back to the numeric uid and a --system install unpacked
  # $PREFIX/node/bin/node as uid 1001, which on a machine with a first human
  # account is that person. That is the interpreter the unit's ExecStart names
  # outright: root-owned is the whole point of keeping it out of the
  # chown below, and an unrelated local user owning it instead is the same hole
  # with a stranger in it. Captured, not reasoned about: the --system block
  # asserts root over the whole of $PREFIX/node, and read UNKNOWN there until
  # this flag was on the line.
  rm -rf "$NODE_HOME.new"
  mkdir -p "$NODE_HOME.new"
  tar -xzf "$work/$file" -C "$NODE_HOME.new" --strip-components=1 --no-same-owner
  printf '%s\n' "$version" >"$NODE_HOME.new/$NODE_STAMP"
  rm -rf "$NODE_HOME"
  mv "$NODE_HOME.new" "$NODE_HOME"
  rm -rf "$work"
  trap - EXIT

  [ -x "$NODE_DIR/node" ] || die "unpacked Node but $NODE_DIR/node is not executable"
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
  # The one shape the plan has two of, and the second one is a dry run that
  # declined to download. It names what would be installed and where from, and
  # not a URL it would have had to invent a version for.
  if [ -z "$PACKAGE_SPECS" ]; then
    report 'package' "$INSTALL_COMPONENTS from $RELEASE_DOWNLOAD_URL into $PREFIX, at whatever versions the line above resolves to"
    return 0
  fi

  report 'package' "$PACKAGE_SPECS into $PREFIX"
  [ "$DRY_RUN" = 'no' ] || return 0

  local npm
  npm="$(npm_command)"

  # --ignore-scripts=false rather than whatever the operator's npmrc says.
  # node-pty's install scripts are what compile the addon, and the pty package's
  # postinstall restores the executable bit the npm tarball drops from node-pty's
  # spawn-helper. An npmrc carrying ignore-scripts=true produces an install that
  # reports success and a service that cannot start, and that postinstall cannot
  # warn about it because it is disabled by the same setting.
  #
  # One npm invocation for every package this role needs, rather than one each.
  # npm resolves them together, so a machine ends up with the set or with none of
  # it -- and a hub whose client package failed to install is a hub serving 503,
  # which is a worse thing to arrive at halfway through a loop than at a failed
  # command.
  #
  # PACKAGE_SPECS is deliberately unquoted: it is a list of specs and npm wants
  # them as separate arguments.
  # shellcheck disable=SC2086
  "$npm" install --global --prefix "$PREFIX" --ignore-scripts=false $PACKAGE_SPECS

  [ -x "$BIN_DIR/$PACKAGE_NAME" ] || die "npm reported success and there is no $BIN_DIR/$PACKAGE_NAME"
}

# What the service account owns on a --system machine: its state and the trees
# npm writes into, and not the interpreter it is started through.
#
# Something under the prefix has to be writable by that account. `agentplex
# setup` installs providers with `npm install --global --prefix $PREFIX` as the
# service account, so a wholly root-owned prefix would turn the first provider
# install into a permission error nobody would connect to this script. The
# question this answers is how much.
#
# `chown -R $PREFIX` was the old answer, and the blast radius was the whole
# prefix. This account runs coding agents, which is the most exposed program on
# the machine; owning the prefix meant owning $PREFIX/node/bin/node -- the
# interpreter ExecStart resolves through -- so anything that got out of a
# session could replace the runtime and be re-executed on every restart
# thereafter, and could rewrite the settings file holding the client token.
#
# So: the two directories npm installs a global package into, $PREFIX/share
# beside them, and the state directory. $PREFIX itself, $PREFIX/lib and
# $PREFIX/node stay root's.
#
# $PREFIX/share is the one that is not obvious. npm links a package's man pages
# into <prefix>/share/man and creates the directory on the way, so an account
# that cannot write the prefix root ends a provider install with EACCES on
# mkdir. Run rather than reasoned about: npm 11 installing a package with a
# `man` field into a prefix whose root it did not own failed exactly there, and
# succeeded once share/ existed and was its own.
#
# What this does not buy, and the comment must not be read as claiming: the
# account still owns $PREFIX/lib/node_modules and $PREFIX/bin, so it can still
# overwrite agentplex's own code and the link that is started. It cannot replace
# the interpreter and it cannot rewrite its own settings. That is a reduction in
# what one compromised session reaches, not isolation from it; isolating the
# package tree as well means a second prefix for providers, which is not this.
grant_service_account_ownership() {
  [ "$UNIT_SCOPE" = 'system' ] || return 0

  report 'ownership' "$SERVICE_USER owns $BIN_DIR, $PREFIX/lib/node_modules, $PREFIX/share and $STATE_DIR; root keeps $NODE_HOME and $ENV_FILE"
  [ "$DRY_RUN" = 'no' ] || return 0

  # Created rather than assumed to be there. npm makes bin/ and lib/node_modules
  # on its way to installing the package but makes share/ only for a package
  # with man pages, and useradd made the state directory only if this run was
  # the one that created the account -- so a chown on its own would die on a
  # path that is simply not there yet.
  local path
  for path in "$BIN_DIR" "$PREFIX/lib/node_modules" "$PREFIX/share" "$STATE_DIR"; do
    mkdir -p "$path"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$path"
  done
}

# The npm that belongs to the Node this run settled on, taken from beside it.
#
# A Node unpacked into $PREFIX/node is not on PATH yet, so `npm` there would be
# the machine's own -- an older one, or none at all -- compiling a native addon
# against a runtime this service refuses. The tarball carries npm in its own
# bin/ beside node, which is NODE_DIR, so this keeps working unchanged now that
# NODE_DIR is $PREFIX/node/bin rather than $PREFIX/bin. Beside-it is right for
# an adopted Node too: whatever version manager put that node there put its npm
# in the same directory.
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
  # file that is briefly world-readable is world-readable. A --system run widens
  # it below by exactly the group-read bit, after the write and never before it,
  # so the file is never wider than the mode it ends up with.
  ( umask 077 && cat >"$ENV_FILE" <<ENVIRONMENT
# agentplex settings, read by the systemd units as an EnvironmentFile. Both
# daemons read this one file, and each reads only the keys it needs.
#
# install.sh wrote this file once and will not touch it again. Three lines are
# uncommented because they are the three facts the installer had: the role you
# asked for, the prefix it created, and the bin path inside it. The rest is
# commented out because guessing a database path or a store path is worse than
# leaving one absent -- fill them in, or let \`$PACKAGE_NAME setup\` do it.
#
# Every setting here has a flag as well, and the flag wins. The whole table is
# at $DOCS_URL

AGENTPLEX_ROLE=$ROLE

# The prefix this install created, recorded so that it can be given back. No
# daemon reads this line: it is here for the person who runs
# \`$PACKAGE_NAME setup --prefix=\$AGENTPLEX_PREFIX\` on this machine later, and
# for whoever is reading the file to find out where everything went. A setup run
# that is not told owns \$HOME/.agentplex instead, which on a machine installed
# anywhere else is a second prefix nothing points at.
AGENTPLEX_PREFIX=$PREFIX

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

  # Root's file, read by the daemon and writable by nothing the daemon runs.
  #
  # The account needs what is in here -- the client token, the paths -- so it
  # gets group read and nothing else. A daemon that can rewrite its own settings
  # is a session that can point this machine's server at another hub on the next
  # restart, and the file is written once by an installer anyway: there is no
  # step after this one that has any business writing it as the account.
  #
  # The owner and the mode are one decision and are set together. 0640 owned by
  # the account is the account writing it again, and root:account at 0600 is a
  # daemon that cannot read its own settings.
  if [ "$UNIT_SCOPE" = 'system' ]; then
    chown "root:$SERVICE_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
}

# The unit file a daemon gets: agentplex-hub.service, agentplex-server.service.
unit_file() {
  echo "$UNIT_DIR/${PACKAGE_NAME}-$1.service"
}

# Whether this machine can hold a systemd unit at all. macOS has no systemd,
# and a container may have none.
#
# The answer is a reason rather than a yes or a no, and the two reasons stay
# apart because they send the operator to different places: macOS wants
# launchd, and a Linux box without systemctl wants systemd installed or the
# daemon started by hand.
#
# It answers and says nothing. A predicate that reports prints its line once
# per caller, which is how a question two steps asked ended up in the plan
# twice; the step that needs the answer reports it instead.
resolve_unit_support() {
  if [ "$PLATFORM" != 'linux' ]; then
    UNIT_SKIP_REASON='macOS has no systemd, hand the process to launchd'
  elif ! have systemctl; then
    UNIT_SKIP_REASON='no systemctl on this machine'
  fi
}

# The units, written and never started. There is no client token, no database
# file and no store path until setup or the operator has filled the settings
# file in, so a unit this script started would be a service that fails on its
# first line. The summary says what to run once the file is complete.
write_units() {
  if [ -n "$UNIT_SKIP_REASON" ]; then
    report 'unit' "skipped: $UNIT_SKIP_REASON"
    return 0
  fi

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
}

# How a daemon is started, as one command line: the interpreter this install
# settled on, and the daemon's compiled entry inside the package npm wrote.
#
# It used to be "$BIN_DIR/$PACKAGE_NAME $daemon", and that stopped being true
# rather than stopped being tidy. A daemon is not a command: there is no
# `agentplex hub` to type, no hub bin on anybody's PATH, and the one binary this
# package installs answers `hub` by explaining what a hub is. So the unit has to
# name the program it starts, and the only name a program has here is its file.
#
# Both halves are constants this script already carries, which is the whole
# argument for the shape. $NODE_DIR is the runtime it adopted or unpacked --
# already the thing it asserts is executable before it declares the runtime
# ready. The package directory is npm's own layout, which `uninstall_package`
# already bets on. Inside it the path is the workspace's, the same in a
# checkout, in the image and in the tarball, because packaging keeps that layout
# on purpose.
#
# The package is the daemon's own now, not the one package there used to be: a
# hub machine has no `.../agentplex-server` directory to point at, and naming
# the wrong one would be a unit that starts nothing on exactly the machine the
# split was for.
#
# It is strictly better than what it replaces, and not only equivalent. The old
# ExecStart named a script whose first line is #!/usr/bin/env node, so systemd
# started a program that then went looking for its own interpreter on a PATH the
# unit had to be careful to set -- a service that dies before `main` on a machine
# where that lookup lands somewhere else, with an error about `node` and nothing
# about agentplex. Naming the interpreter deletes that failure rather than
# guarding against it: this unit starts this Node, and no search decides.
daemon_command() {
  printf '%s %s' "$NODE_DIR/node" \
    "$PREFIX/lib/node_modules/$(daemon_package "$1")/apps/$1/dist/main.js"
}

# The package that holds one daemon's compiled entry.
#
# Every daemon is a component, so this is `component_package` with the two
# components that are not daemons refused: `cli` holds no daemon and `web` is
# static files. Going through the one table rather than a second copy of it is
# what keeps a machine's ExecStart from depending on the published names
# happening to end in the daemon's word.
daemon_package() {
  case "$1" in
    hub | server) component_package "$1" ;;
    *) die "no package holds a $1 daemon" ;;
  esac
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
  # network-online.target belongs to the system manager. A user manager has its
  # own much smaller set of targets and no such unit, so naming it in a user
  # unit orders against nothing at all -- a line that reads as a guarantee and
  # is not one. Nothing replaces it: both daemons dial out and retry, so there
  # is nothing here for an ordering to buy.
  local network_ordering=''
  if [ "$UNIT_SCOPE" = 'system' ]; then
    install_target='multi-user.target'
    identity="User=$SERVICE_USER
Group=$SERVICE_USER
"
    network_ordering="After=network-online.target
Wants=network-online.target
"
  fi

  cat <<UNIT
[Unit]
Description=agentplex $daemon
Documentation=$DOCS_URL
${network_ordering}
[Service]
Type=simple
${identity}WorkingDirectory=$STATE_DIR
EnvironmentFile=$ENV_FILE
# The prefix goes first, and the directory holding the node this install
# settled on comes with it when that is somewhere a service would never look --
# $PREFIX/node/bin, or a version manager's shims.
#
# The reason is no longer ExecStart. That line names the interpreter and the
# script outright, so it resolves nothing through this PATH and cannot be the
# #!/usr/bin/env node failure it used to be. What is left is everything the
# daemon starts afterwards, and it is reason enough on its own: a session is not
# only the agent, it shells out to git, rg and whatever else the project needs,
# and the coding agents agentplex setup installs into the prefix's bin are
# themselves scripts whose first line is #!/usr/bin/env node, which finds
# nothing unless the runtime's own directory is named here. In front of the rest
# of the machine rather than instead of it.
Environment=PATH=$(unit_search_path)
ExecStart=$(daemon_command "$daemon")
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
# somewhere a service already searches, then the machine.
#
# What this is for changed when ExecStart started naming the interpreter. It is
# no longer what stops the unit dying on the `#!/usr/bin/env node` line of the
# program it was pointed at -- nothing is pointed at any more, systemd starts a
# node this script names in full -- and keeping the old sentence would be
# defending a line with a reason it no longer has.
#
# It is still needed, for the processes the daemon starts rather than for the
# daemon. $BIN_DIR is where `agentplex setup` installs the coding agents, and
# every one of them is a script looking for `node`; a session then shells out to
# git, rg and whatever else the project needs, which is what the machine's own
# directories at the end are for. The Node directory is named for the agents and
# not for us: it is $PREFIX/node/bin, or a version manager's shims under ~/.nvm
# or ~/.local/share/fnm, and either way it is somewhere systemd would never look.
# One mechanism for both, so that a Node in an unexpected place has only ever had
# one answer.
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
    report 'setup' "would run $BIN_DIR/$PACKAGE_NAME setup --role=$ROLE --prefix=$PREFIX"
    return 0
  fi

  report 'setup' "$BIN_DIR/$PACKAGE_NAME setup --role=$ROLE --prefix=$PREFIX"
  say ''

  local status='0'
  "$BIN_DIR/$PACKAGE_NAME" setup --role="$ROLE" --prefix="$PREFIX" </dev/tty || status="$?"

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
# Undoing an install
# ---------------------------------------------------------------------------

# What --uninstall removes, and the line it draws.
#
# Everything this script creates is a runtime artifact -- a Node it downloaded,
# a package npm installed, two unit files it rendered -- and every one of them
# comes back from one more run of this script. Nothing it creates is a decision.
# The settings file, the server identity, the hub database and every store are
# decisions or data, none of them comes back from a network, and a script that
# deleted them would be one nobody could run twice. So the runtime goes and the
# state stays -- and the state is printed rather than quietly skipped, because
# the operator who wants this machine actually empty has no other list and the
# operator who is reinstalling needs to know those files survived.
#
# It asks nothing. A prompt here would read the rest of this script off stdin
# under `curl | bash` -- the hazard `run_setup` documents at length -- and a
# confirmation nobody is there to answer is a hang rather than a safeguard. What
# stands in for one is that nothing is removed because a flag named it. Every
# directory below is removed because a marker this script wrote is in it:
# `$NODE_HOME/$NODE_STAMP` for the runtime, and a package directory under
# `lib/node_modules/@softiesolutions` for the packages. `--dry-run`
# prints the whole list first, `validate_prefix` has already refused the prefix
# shapes a removal must not be handed, and the directories that are left over
# are cleared with `rmdir`, which cannot take anything with it.
uninstall() {
  local found='no'

  if uninstall_units; then found='yes'; fi
  if uninstall_node; then found='yes'; fi
  if uninstall_package; then found='yes'; fi

  if [ "$found" = 'no' ]; then
    say "Nothing of $PACKAGE_NAME's is here to remove: no unit in $UNIT_DIR, no runtime"
    say "in $NODE_HOME, no package under $PREFIX/lib/node_modules."
    say ''
    say 'An install made somewhere else needs the same --prefix it was given, and one made'
    say 'with --system needs --system.'
    return 0
  fi

  # Only what is empty, and only with rmdir. A prefix that still holds a
  # provider `agentplex setup` installed, or a settings file, or a database,
  # keeps all of it and stays exactly where it is.
  if [ "$DRY_RUN" = 'no' ]; then
    rmdir "$PREFIX/lib/node_modules" "$PREFIX/lib" "$BIN_DIR" "$PREFIX/share" "$PREFIX" 2>/dev/null || true
  fi

  uninstall_state_notice
}

# The units, stopped and disabled before they are removed: a unit file deleted
# from under a running service leaves a service running with nothing behind it,
# and systemd still listing a job for a file that is gone.
#
# Both daemons, whatever --role says. --role decides what an install writes;
# an uninstall is about what is on the disk, and a hub unit left behind because
# the operator typed --role=server the second time is exactly the thing they
# asked to be rid of.
uninstall_units() {
  local daemon file found='no'

  for daemon in hub server; do
    file="$(unit_file "$daemon")"
    [ -e "$file" ] || continue
    found='yes'

    if [ -n "$UNIT_SKIP_REASON" ]; then
      report 'unit' "remove $file (nothing here to stop it with: $UNIT_SKIP_REASON)"
    else
      report 'unit' "stop, disable and remove $file"
    fi
    [ "$DRY_RUN" = 'no' ] || continue

    if [ -z "$UNIT_SKIP_REASON" ]; then
      # A unit that was written and never enabled -- which is every unit this
      # script writes, until somebody enables it -- makes both of these exit
      # non-zero, as does a user manager that is not running. That is the
      # expected case here and not a failure to stop the run over.
      unit_systemctl stop "${PACKAGE_NAME}-${daemon}.service" >/dev/null 2>&1 || true
      unit_systemctl disable "${PACKAGE_NAME}-${daemon}.service" >/dev/null 2>&1 || true
    fi
    rm -f "$file"
  done

  if [ "$found" = 'yes' ] && [ "$DRY_RUN" = 'no' ] && [ -z "$UNIT_SKIP_REASON" ]; then
    unit_systemctl daemon-reload >/dev/null 2>&1 || true
  fi

  [ "$found" = 'yes' ]
}

# systemctl in the scope this run resolved, which is the scope the unit files
# were written into.
unit_systemctl() {
  if [ "$UNIT_SCOPE" = 'system' ]; then
    systemctl "$@"
  else
    systemctl --user "$@"
  fi
}

# The runtime directory, removed only when the record this script writes into it
# is there.
#
# Without that record the directory is somebody else's, and removing it would be
# the one thing `resolve_node_directory` refuses to do everywhere else. The
# reply is a line rather than silence: an operator who expected this directory
# to go needs to know why it did not.
uninstall_node() {
  local recorded
  [ -d "$NODE_HOME" ] || return 1

  recorded="$(node_recorded_version)"
  if [ -z "$recorded" ]; then
    report 'node' "$NODE_HOME left alone: no record here that this script installed it"
    return 0
  fi

  report 'node' "remove $NODE_HOME ($recorded)"
  [ "$DRY_RUN" = 'no' ] || return 0
  rm -rf "$NODE_HOME"
}

# The packages npm installed, and the link it made in the prefix's bin.
#
# A package directory under $PREFIX/lib/node_modules is the marker as much as
# the target: one is there because this script ran `npm install --global
# --prefix $PREFIX`, and a prefix with none of them is not a prefix this script
# installed into. That is what keeps a mistyped `--uninstall --prefix=/usr/local`
# from being a command that empties /usr/local/bin, and splitting one package
# into four does not weaken it: every one of the four is ours, so any one of
# them answers the same question, and a prefix holding none answers it too.
#
# All four, whatever --role says, for the same reason the units are all removed:
# --role decides what an install writes, and an uninstall is about what is on
# the disk. A hub package left behind because the operator typed --role=server
# the second time is exactly the thing they asked to be rid of.
#
# It takes the packages and not the tree around them. A provider `agentplex
# setup` installed into the same prefix was put there by something else, and
# what it leaves behind is a directory the rmdir sweep then declines to remove
# and the notice below names.
uninstall_package() {
  local component tree found='no'

  for component in $COMPONENTS; do
    tree="$PREFIX/lib/node_modules/$(component_package "$component")"
    [ -e "$tree" ] || continue
    found='yes'
    report 'package' "remove $tree"
    [ "$DRY_RUN" = 'no' ] || continue
    rm -rf "$tree"
  done

  [ "$found" = 'yes' ] || return 1

  report 'package' "remove $BIN_DIR/$PACKAGE_NAME"
  [ "$DRY_RUN" = 'no' ] || return 0
  rm -f "$BIN_DIR/$PACKAGE_NAME"
  # The scope directory is npm's rather than this project's, so it goes only
  # when it is empty: `rmdir` takes it when these were the only packages
  # published under the scope in this prefix and leaves it, and says nothing,
  # when they were not. Without this the sweep below finds a `lib/node_modules`
  # that is not empty and the whole prefix stays behind.
  rmdir "$PREFIX/lib/node_modules/$NPM_SCOPE" 2>/dev/null || true
}

# What is still here, said out loud rather than left for somebody to find.
uninstall_state_notice() {
  local -a kept=()
  local path

  for path in "$ENV_FILE" "$STATE_DIR" "$PREFIX"; do
    [ -e "$path" ] || continue
    case " ${kept[*]-} " in
      *" $path "*) continue ;;
    esac
    kept+=("$path")
  done

  say ''
  if [ "${#kept[@]}" -eq 0 ]; then
    say 'Nothing was left behind: there was no settings file and no state directory here.'
  else
    say 'Left in place, because none of it comes back from a download:'
    for path in "${kept[@]}"; do
      say "  $path"
    done
    if [ "$UNIT_SCOPE" = 'system' ]; then
      say "  the $SERVICE_USER account, which owns the state directory and what is in it"
    fi
    say ''
    say 'Every store is left too, wherever it is: this script has never known a store path,'
    say "and $ENV_FILE is where the ones this machine had are named."
    say 'Remove what you want gone by hand.'
  fi

  say ''
  say "Documentation: $DOCS_URL"
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
  # The machine that got no unit is the machine with nothing to start what was
  # just installed, so it is the one that most needs telling. The reason is
  # asked before the files are, because a unit left behind by an earlier run is
  # not a systemctl to enable it with.
  if [ -n "$UNIT_SKIP_REASON" ]; then
    say ''
    say "No unit was written: $UNIT_SKIP_REASON."
    say "Nothing will start ${PACKAGE_NAME} for you, so run a daemon yourself once"
    say "$ENV_FILE is complete:"
    for daemon in $DAEMONS; do
      # The same line the unit would have carried, and long for the same reason:
      # there is no command for a daemon, so there is nothing shorter to print
      # that would start one. An operator handing this to launchd needs the
      # literal argv anyway, and a short form they had to expand themselves is
      # where a wrong interpreter gets chosen.
      say "  $(daemon_command "$daemon")"
    done
    say 'What to hand it to instead -- launchd on macOS -- is in the documentation below.'
  else
    for daemon in $DAEMONS; do
      [ -e "$(unit_file "$daemon")" ] && units="$units ${PACKAGE_NAME}-$daemon"
    done
    if [ -n "$units" ]; then
      say ''
      say 'The units are written and deliberately not started: there is no database file, no'
      say "client token and no store paths until $ENV_FILE has them."
      say ''
      # One command, and not the two spellings of systemctl this used to print.
      #
      # The instructions were correct and they made the operator carry a fact
      # this machine already knows: whether their units belong to the user
      # manager or the system one, and therefore which systemctl reaches them.
      # `agentplex start` reads that off the settings file written above -- the
      # same file, the same branch that chose the unit directory -- and does
      # both steps. `agentplex setup` runs it at the end of a successful run, so
      # on the ordinary path nobody types this at all; it is here for the
      # machine that took --no-setup, and for the second time.
      say "  $BIN_DIR/$PACKAGE_NAME start"
      if [ "$UNIT_SCOPE" = 'user' ]; then
        # Not something `agentplex start` can do for anybody: lingering is a
        # property of the account rather than of a unit, and enabling it is a
        # decision about whether this user's processes outlive their session.
        say "  loginctl enable-linger $SERVICE_USER   # so it runs when you are not logged in"
      fi
      say ''
      say "$PACKAGE_NAME status says what is installed here and whether it is running."
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
