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
# Deliberately ignorant, and now also deliberately short. It does what has to
# happen before there is an `agentplex` on the machine -- a Node runtime, the
# build toolchain a server's native addon needs, the service account of a
# --system install, and the command's own package -- and then hands the rest to
# that command. `agentplex install` resolves and installs the role's other
# packages, checks that they agree on the protocol, gives the service account
# what it writes into, and writes the settings file and a systemd unit per
# daemon the role runs, starting none of them. Last, this script hands over to
# `agentplex setup`. It knows nothing about providers, stores or databases:
# everything provider-specific lives in TypeScript beside the adapter that
# knows the provider, so a new provider is a new file rather than an edit to a
# shell script nobody tests.
#
# The line is drawn at the bin. This script is fetched on its own over HTTPS
# and run on a machine that may have no Node, so it has to get a runtime and
# the command there by itself; everything after that is TypeScript, tested as
# TypeScript, and the same install step `agentplex update` runs. What it still
# has to know is which command to install, because --package-version is exact
# or a series, so it reads the versions manifest for the command's entry alone.
# The command records no protocol leg, so there is nothing here to check.
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
# NPM_PACKAGE is the directory its package is unpacked into under
# `lib/node_modules`, where npm itself would put it. PACKAGE_NAME is everything
# else: the binary in the prefix, the stem of the unit file names, and the word
# in every line an operator reads. Splitting them is the whole of this: passing
# the scoped name where the plain one belongs renames the units and the binary,
# which is a machine an upgrade no longer recognises.
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

# The scope all four are published under, which is the one directory under
# lib/node_modules that holds the lot of them.
readonly NPM_SCOPE='@softiesolutions'

# The command's entry inside its package: the file the bin links to, and the
# one `bin` in the published manifest names. The path is the workspace's, which
# packaging keeps on purpose; the suite holds this against the assembler's own
# constant, so a move there fails here rather than as a dangling link.
readonly CLI_ENTRYPOINT='apps/cli/dist/main.js'

# ---------------------------------------------------------------------------
# Where the packages come from
# ---------------------------------------------------------------------------

# Nothing this project builds is published to a registry, and that is a decision
# rather than a gap.
#
# Each component has its own release train -- a CLI fix must stop forcing every
# server on the fleet to recompile a native addon -- and a release is a GitHub
# Release carrying one tarball. npm is still what installs it: the tarball is
# downloaded and unpacked, and npm then fetches that package's own registry
# dependencies from npm, at the versions the shrinkwrap inside it names -- see
# `install_package`. So npm is used on this machine, and nothing of ours is
# published there.
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
# component and what each release speaks -- before anything is downloaded, which
# is the whole point of asking.
#
# This script reads one entry of it, the command's, because the command is the
# one package it installs; the command reads the rest for itself once it is
# here. It is read off the network, so `read_component_entry` parses it and can
# say no.
readonly VERSIONS_URL='https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/versions.json'

# Every component, which is not every role. `cli` goes on every machine because
# `setup` and `doctor` do; `web` comes with every hub because a hub without the
# client serves 503. Neither is something --role can name. This script installs
# only the first and removes all four, which is what --uninstall reads this for.
readonly COMPONENTS='cli hub server web'

# The command's release asset, the one tarball this script downloads. A constant
# for ever, for the reason RELEASE_DOWNLOAD_URL gives, and held against the
# assembler's own name by `install.sh.integration.test.ts`.
readonly CLI_ASSET='agentplex.tgz'

# The exact version a pin may name: the release tag `<component>-v<version>`
# with the stem taken off.
#
# semver.org's grammar, the expression `packages/release` keys the manifest by,
# with `\d` spelled `[0-9]` and every group capturing because bash has no
# `(?:`. It used to take any run of `[0-9A-Za-z.-]` as a prerelease tail, which
# accepted `1.2.3-01` and `1.2.3-.` -- tags the manifest can never list, so a
# pin to one could only fail later as unpublished. The two copies are held
# together by the table in `packages/release/src/pin-cases.ts`, which
# `install.sh.integration.test.ts` runs through this script and the release
# package runs through `readPin`.
readonly RELEASE_VERSION='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(\+([0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*))?$'

# The series a pin may name instead: `1.3`, or `1`.
#
# A series names no tag, so it is resolved before a URL is built -- against the
# release history `versions.json` carries, to the newest release in that series.
# That file is fetched anyway and is read by the grammar below anyway, so a
# partial pin costs no request and no second parser; what it buys is the shape a
# fleet operator wanting security patches without a minor jump actually reaches
# for.
#
# `1` is accepted as well as `1.3`, and that was the open question. The argument
# for refusing it is that a major-only pin is barely a pin. The argument that
# won: it is the same resolver either way -- a prefix at a dot boundary and the
# newest release under it -- so refusing `1` would mean a second grammar and a
# second refusal to explain, in exchange for withholding the pin semver says is
# the one that constrains the breaking axis. An operator who wants less movement
# than that types more digits.
#
# Prereleases are excluded from what a series can select, in `newest_in_series`
# and not here: `hub@1.3` must not resolve to `1.3.8-rc1`. Naming that candidate
# exactly still works, because an exact pin names a tag and that tag exists.
readonly PARTIAL_VERSION='^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$'

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
# the word the handover to `setup` and the summary carry; `agentplex install`
# derives the same word from the same flags.
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
# The arguments `agentplex install` is handed, exactly as they were typed:
# every --role, --package-version, --prefix and --system, in order. --dry-run
# and --print-unit are added by the step that hands over, and --no-setup is
# never passed, because handing over to setup is this script's. Set by
# parse_arguments.
INSTALL_ARGS=()
# The daemons this role runs, which is what the summary and the toolchain ask
# about. Set by resolve_role from ROLE_COMPONENTS.
DAEMONS=''
SERVICE_USER=''
STATE_DIR=''
# Where the command's tarball comes from -- a release URL, or a file under
# AGENTPLEX_PACKAGE -- and empty when a dry run could not resolve one. The plan
# prints it; `install_package` fetches and unpacks it. Set by resolve_release.
CLI_SPEC=''
# The version of the command this run would install: resolved out of the
# manifest, or read off the name of a local tarball, and empty when a dry run
# could not say. The handover compares it with what the prefix already holds.
# Set by resolve_release.
CLI_VERSION=''
# The versions manifest as text, and where it was read from -- empty when it was
# not read at all, which is every dry run that would have had to download it.
# Set by load_versions.
VERSIONS_TEXT=''
VERSIONS_SOURCE=''
# The command's line out of that manifest: the version it calls current and the
# versions its release history lists. Set by read_component_entry, which checks
# the whole history against the grammar before the list is filled, and read by
# the two functions that resolve a version.
MANIFEST_CURRENT=''
MANIFEST_RELEASE_VERSIONS=''
# The release a pin or the manifest resolved to. Set by read_versions_entry and
# read_pinned_release.
RESOLVED_VERSION=''
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
# Set by resolve_unit_support, read by --uninstall and by the summary; the units
# themselves are `agentplex install`'s, which asks the same question.
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
  --print-unit                 print the systemd units, through the ${PACKAGE_NAME} command
                               already in the prefix, and stop
  --uninstall                  remove the units, the runtime and the package; keep the state
  --version                    print this script's own version, and stop
  --help                       this

  This script installs a runtime and the ${PACKAGE_NAME} command, then hands
  the rest to \`${PACKAGE_NAME} install\` with the same --role, --package-version,
  --prefix and --system: the role's other packages, the settings file and the
  units. --dry-run asks that command for its half of the plan when it is already
  here at the version this would install, and names it otherwise.

  --role pre-seeds setup rather than replacing it. --no-setup is for a machine
  that will receive a plan file and run \`${PACKAGE_NAME} setup --plan\` itself.

  A version is exact -- 1.4.0, naming the release tag <component>-v<version> --
  or a series: 1.4 takes the newest 1.4.x and 1 the newest 1.x, never a
  prerelease.

  ${VERSIONS_URL}
  is read by every install, pinned or not: it lists the releases of each
  component and what each one speaks, which is what an unpinned component
  resolves through and what a pin is checked against. Set AGENTPLEX_VERSIONS to
  a directory holding a copy of it to install without reaching that host; the
  ${PACKAGE_NAME} command is handed the same variable.

  Served from ${INSTALL_SH_URL}
  Documentation at ${DOCS_URL}
USAGE
}

main() {
  parse_arguments "$@"
  resolve_layout

  # Before any network or runtime is touched: the units are the command's to
  # render, and printing them asks nothing but which interpreter they name.
  if [ "$PRINT_UNIT" = 'yes' ]; then
    print_units
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
  # disk and has no business asking a network what is current.
  resolve_release
  ensure_toolchain
  ensure_node
  # Before the handover, because `agentplex install --system` gives this
  # account the directories it writes into and the settings file's group, and
  # stops before it installs anything when there is no such account.
  ensure_service_account
  install_package
  hand_over
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
      --role=*)
        add_role "${1#*=}"
        INSTALL_ARGS+=("$1")
        ;;
      --package-version=*)
        set_pin 'cli' "${1#*=}" '--package-version='
        INSTALL_ARGS+=("$1")
        ;;
      --prefix=*)
        PREFIX="${1#*=}"
        # An empty value is almost always an unset variable in the command that
        # produced it, and the default prefix is not what that command meant.
        # It matters most for --uninstall, where a flag that falls back to a
        # default is a removal nobody typed.
        [ -n "$PREFIX" ] || die '--prefix was given with nothing after it, which is usually an unset variable: name the directory, or leave the flag off to take the default'
        INSTALL_ARGS+=("$1")
        ;;
      --no-setup) RUN_SETUP='no' ;;
      --system)
        SYSTEM='yes'
        INSTALL_ARGS+=("$1")
        ;;
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
  if ! [[ "$pin" =~ $RELEASE_VERSION ]] && ! [[ "$pin" =~ $PARTIAL_VERSION ]]; then
    die "$(quote "$pin") is not a version this can install: a pin is an exact <major>.<minor>.<patch>, naming the release tag ${component}-v<version>, or a series -- <major>.<minor> or <major> -- which resolves to the newest release published under it"
  fi

  case " $COMPONENT_PINS " in
    *" $component="*) die "$component is pinned twice, and two versions of one component is a contradiction rather than a last-one-wins" ;;
  esac
  COMPONENT_PINS="${COMPONENT_PINS:+$COMPONENT_PINS }$component=$pin"
}

# What the role decides here: the word this machine records and the daemons it
# runs. Which components each role installs is `agentplex install`'s, which
# reads the same flags.
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
  elif [ "$has_hub" = 'yes' ]; then
    ROLE='hub'
    DAEMONS='hub'
  else
    ROLE='server'
    DAEMONS='server'
  fi
}

# The published name of one component, which is the directory npm's layout puts
# it in under lib/node_modules.
#
# Four cases rather than four strings built out of the component word. The
# names happen to end in the component's word today, and what a machine removes
# is the wrong thing to have depend on that continuing to be true. The command
# is the one this script installs; all four are what --uninstall takes away.
component_package() {
  case "$1" in
    cli) printf '%s' "$NPM_PACKAGE" ;;
    hub) printf '%s' "$NPM_PACKAGE_HUB" ;;
    server) printf '%s' "$NPM_PACKAGE_SERVER" ;;
    web) printf '%s' "$NPM_PACKAGE_WEB" ;;
    *) die "no package holds the $1 component" ;;
  esac
}

# One file published at one release tag.
release_url() {
  printf '%s/%s-v%s/%s' "$RELEASE_DOWNLOAD_URL" "$1" "$2" "$3"
}

# The value one of the `<component>=<value>` lists holds for a component, and
# nothing at all when it holds none. Empty is an answer here rather than a
# failure: an unpinned component has no pin.
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

# Where the command's package comes from, and which release it is.
#
# The command's alone. It is the one package this script installs, because it
# is the one thing that has to be on the machine before the rest can be done by
# something other than bash; every other package a role needs, and whether they
# agree on the protocol, is `agentplex install`'s to resolve, out of the same
# manifest, handed the same two variables.
#
# Two sources, and only one of them is a release.
#
# **AGENTPLEX_PACKAGE** is the seam this repository's own container check
# installs through: a directory of packed tarballs from a build that has never
# been published. Nothing in it is a release, so nothing is resolved, and this
# says so rather than implying a version it does not have. The name npm packed
# the command's tarball under still carries a version, and that is read off it
# the way `agentplex install` reads it, so the handover can tell whether the
# prefix already holds this build.
#
# **versions.json** answers everything else, in one unauthenticated fetch,
# before a byte of any tarball is downloaded. It carries every release the
# command has published, so it says which release a series resolves to and
# whether an exact pin names one at all.
resolve_release() {
  if [ -n "${AGENTPLEX_PACKAGE:-}" ]; then
    [ -d "$AGENTPLEX_PACKAGE" ] || die "AGENTPLEX_PACKAGE names $(quote "$AGENTPLEX_PACKAGE"), which is not a directory: it is the directory holding the packed tarballs to install, one per package"
    CLI_SPEC="$(package_tarball "$NPM_PACKAGE")"
    CLI_VERSION="$(tarball_version "$CLI_SPEC" "$NPM_PACKAGE")"
    report 'release' "the tarballs in $AGENTPLEX_PACKAGE; no version is resolved and no protocol is checked, because a directory of tarballs is one build and not a release"
    return 0
  fi

  load_versions
  resolve_cli_version
  CLI_SPEC=''
  [ -z "$CLI_VERSION" ] || CLI_SPEC="$(release_url cli "$CLI_VERSION" "$CLI_ASSET")"
  report_release
}

# The versions manifest, off the network or off a disk.
#
# Always, now, and not only when something was left unpinned. The file carries
# every release each component has published, so a pinned run reads it too: an
# exact pin to learn that it names a release, a series to find out which
# release it is. That is one fetch where a fully pinned install used to make one
# per pin against a second artifact, so this is fewer requests and not more --
# what it costs is that a machine that cannot reach the manifest at all can no
# longer install by pinning everything. `AGENTPLEX_VERSIONS` is the answer to
# that, and it is the one an air-gapped fleet was going to need anyway.
#
# **A dry run downloads nothing**, which is the rule `ensure_node` already keeps
# about the Node release file, and for the same reason: "would install 1.4.0" is
# a claim a run that performed no download cannot make. So a dry run with
# nothing to read the manifest from names the command and says the question
# went unasked, rather than printing a version it guessed.
#
# AGENTPLEX_VERSIONS is what makes that testable and what an air-gapped mirror
# would use. It names a directory holding `versions.json` at its root -- the
# same file at the same name, one origin further down. Reading a local file is
# not a download, so a dry run reads it.
load_versions() {
  local file

  if [ -n "${AGENTPLEX_VERSIONS:-}" ]; then
    file="$AGENTPLEX_VERSIONS/versions.json"
    [ -f "$file" ] || die "AGENTPLEX_VERSIONS names $(quote "$AGENTPLEX_VERSIONS"), which holds no versions.json: it is the directory holding a copy of the manifest the release publishes"
    VERSIONS_TEXT="$(cat "$file")"
    VERSIONS_SOURCE="$file"
    return 0
  fi

  [ "$DRY_RUN" = 'no' ] || return 0

  file="$(mktemp)"
  if ! fetch "$VERSIONS_URL" "$file"; then
    rm -f "$file"
    die "could not reach $VERSIONS_URL, which is what says which releases of each component exist and what each one speaks. Every install reads it, pinned or not, because a pin is a claim about a release and this is the record of which releases there are. Point AGENTPLEX_VERSIONS at a directory holding a copy of it to install without reaching this host"
  fi
  VERSIONS_TEXT="$(cat "$file")"
  rm -f "$file"
  VERSIONS_SOURCE="$VERSIONS_URL"
}

# The command's version, pinned or current.
#
# Only a dry run reaches here with no manifest; a real run has already died
# trying to fetch one. An exact pin is still an answer without it -- it names
# the tag outright -- and a series is not, because resolving one is exactly
# what needed the file.
resolve_cli_version() {
  local pin
  pin="$(component_pin cli)"
  CLI_VERSION=''

  if [ -z "$VERSIONS_SOURCE" ]; then
    if [ -n "$pin" ] && [[ "$pin" =~ $RELEASE_VERSION ]]; then
      CLI_VERSION="$pin"
    fi
    return 0
  fi

  if [ -n "$pin" ]; then
    read_pinned_release cli "$pin"
  else
    read_versions_entry cli
  fi
  CLI_VERSION="$RESOLVED_VERSION"
}

# The release a pin names, decided before anything is installed. Sets
# RESOLVED_VERSION.
#
# A pin the manifest does not list stops the run, and the refusal says what the
# file is rather than what exists. It is the set of releases this source
# advertises: the `v1` branch lists every 1.x release including prereleases, so
# `--package-version=1.3.8-rc1` resolves here like any other, but it lists no
# 2.x -- that train advertises itself from its own branch -- and a mirror holds
# whatever was copied into it. Refusing here is still better than the
# alternative, which is a 404 partway through an npm install.
read_pinned_release() {
  local component="$1" pin="$2"
  read_component_entry "$component"

  if [[ "$pin" =~ $RELEASE_VERSION ]]; then
    RESOLVED_VERSION="$pin"
  else
    RESOLVED_VERSION="$(newest_in_series "$MANIFEST_RELEASE_VERSIONS" "$pin")"
    [ -n "$RESOLVED_VERSION" ] || die "$VERSIONS_SOURCE offers no $component release under $pin, so ${component}@${pin} names a series it advertises nothing in. A series takes the newest release under it and never a prerelease; a prerelease named exactly is installed"
  fi

  release_listed "$RESOLVED_VERSION" || die "$VERSIONS_SOURCE offers no $component release at $RESOLVED_VERSION, so there is nothing here to install ${component}-v${RESOLVED_VERSION} from. This file is the set of releases it advertises and not the set of tags that exist: a 2.x release is advertised from its own branch, and a mirror holds whatever was copied into it"
}

# The command's release, and where it came from -- or, for a dry run that read
# no manifest, what it could not know. One line, because the command records no
# protocol leg: there is no agreement here to report, and the lines about the
# other packages are the command's own, printed when it is handed the rest.
report_release() {
  if [ -n "$VERSIONS_SOURCE" ]; then
    report 'release' "cli $CLI_VERSION (from $VERSIONS_SOURCE)"
  else
    report 'release' "cli ${CLI_VERSION:-(not resolved)}: a dry run downloads nothing, and $VERSIONS_URL is a download"
  fi
}

# ---------------------------------------------------------------------------
# Reading the JSON a release publishes
# ---------------------------------------------------------------------------
#
# One file, small, written by the release workflow out of the assembled
# manifests, and read off the network:
#
#   versions.json   {"cli":{"current":"1.4.0","releases":{"1.4.0":{},"1.3.0":{}}},
#                    "hub":{"current":"1.2.0","releases":{"1.2.0":{"client":3,"server":3}}}, ...}
#
# Parsed and not read. It is a claim out of another program, off a branch
# anybody with write access can push to, and the whole reason this script
# fetches it before it downloads anything is so that a bad one costs a refusal
# rather than a half-installed machine. There is no jq on a stock
# debian:bookworm-slim and no node either -- this runs before `ensure_node` has
# put one there -- so the parser is bash, and it is written as a grammar that
# refuses rather than as an extractor that guesses: a field that is not there, a
# version that is not a version and a protocol leg that is not a positive
# integer each stop the run naming the file. It reads the command's entry, the
# only one this script installs from, and all of it.
#
# There used to be a second file, `<component>-v<version>.json` beside each
# tarball, and the release history is what deleted it -- see `read_pinned_release`.
#
# Two levels of nesting are the whole of what this has to handle: `releases` is
# an object of `<version>: <legs>`, each release's legs are an object of
# `client` and `server` integers, and nothing nests further. That is why
# `object_body` counts braces rather than the entry readers slicing at the
# first `}` they meet, and why a component's history is walked release by
# release against a grammar (`read_release_history`) rather than searched for
# the one key a run wants: a search cannot tell a release with no client leg
# from one whose client leg it failed to read, and the second must stop the
# run.
#
# Whitespace is deleted outright rather than skipped over, which is what makes
# the field patterns below one-liners. Nothing this file holds can contain a
# space: a component is one of four words, a version is a semver, a leg name is
# one of two words and its value is an integer, and anything that did contain
# one would fail the checks that follow rather than slip through reshaped.

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

# The text of one JSON object, given everything after its opening brace, with
# the brace that closes it removed.
#
# A brace counter and not a slice at the first `}`, because `releases` is an
# object inside an object and the first `}` after a component's name is the one
# that ends its history rather than its entry. Non-zero when the text runs out
# first, which is a truncated file rather than an empty object.
#
# It walks brace to brace rather than character to character, so the loop runs
# four times for a component's entry however many releases are listed in it.
object_body() {
  local rest="$1" body='' depth=1 open close

  while [ -n "$rest" ]; do
    # Two expansions and a length compare, rather than one pattern matching
    # either brace. `${rest%%[{}]*}` is the obvious way to write that and it
    # does not work: the `}` inside the bracket expression closes the expansion
    # before the pattern is ever read, so the whole thing silently matches
    # nothing and the loop never advances. Verified at the origin, by watching
    # it not advance.
    open="${rest%%\{*}"
    close="${rest%%\}*}"
    # An expansion that changed nothing means the brace is not in the rest of
    # the text at all, and no closing brace is a file that ends mid-object.
    [ "$close" != "$rest" ] || return 1

    if [ "$open" != "$rest" ] && [ "${#open}" -lt "${#close}" ]; then
      depth=$((depth + 1))
      body="$body$open{"
      rest="${rest#"$open"\{}"
      continue
    fi

    depth=$((depth - 1))
    if [ "$depth" -eq 0 ]; then
      printf '%s' "$body$close"
      return 0
    fi
    body="$body$close}"
    rest="${rest#"$close"\}}"
  done
  return 1
}

# One component's line out of the versions manifest. Sets MANIFEST_CURRENT and
# MANIFEST_RELEASE_VERSIONS.
#
# It assigns rather than prints, and that is not a style choice. A refusal in
# here is a `die`, and `die` inside `$(...)` exits the subshell -- which the
# bash macOS ships as /bin/bash, still 3.2, then declines to propagate out of a
# *nested* substitution even under `set -e`. Verified at the origin: a manifest
# that was not an object printed its refusal from two substitutions down and the
# run carried on to a second, vaguer one about the same file. Assigning keeps
# every refusal in the process that has to stop. The pure readers below are
# still called through `$(...)`, because they return a status rather than dying
# and every caller of one writes the `|| die` out.
#
# A component this run needs and the manifest does not name is a refusal and not
# a fallback to anything: the manifest is what says which releases there are.
read_component_entry() {
  local component="$1" flat entry releases

  flat="$(flatten_json "$VERSIONS_TEXT")"
  case "$flat" in
    '{'*'}') ;;
    *) die "$VERSIONS_SOURCE is not a versions manifest: it holds no JSON object" ;;
  esac

  case "$flat" in
    *"\"$component\":{"*) ;;
    *) die "$VERSIONS_SOURCE names no $component, and every machine installs one. It is the manifest of every release of every component, so a missing entry is a release that did not finish rather than something to guess at" ;;
  esac
  entry="$(object_body "${flat#*\""$component"\":\{}")" || die "$VERSIONS_SOURCE ends in the middle of the $component entry"

  MANIFEST_CURRENT="$(json_string "$entry" 'current')" || die "$VERSIONS_SOURCE gives $component no current version"
  case "$entry" in
    *'"releases":{'*) ;;
    *) die "$VERSIONS_SOURCE gives $component no releases, and that list is what says which versions of it exist and what each one speaks" ;;
  esac
  releases="$(object_body "${entry#*\"releases\":\{}")" || die "$VERSIONS_SOURCE ends in the middle of the $component releases"
  read_release_history "$component" "$releases"
}

# Every release in one component's history, checked against the grammar and
# recorded. Sets MANIFEST_RELEASE_VERSIONS.
#
# The whole history and not only the release this run wants, so that a file
# that is wrong anywhere is refused rather than being right about the one
# release somebody happened to ask for. And it assigns rather than prints, for
# the reason `read_component_entry` gives: every refusal here is a `die`.
#
# The legs are read and not kept. The command records none, and what the other
# components speak is `agentplex install`'s question -- but a leg this cannot
# read is a file this cannot read, and saying nothing about it would be reading
# the one release somebody asked for and calling the rest fine.
#
# One release is `"<version>":{<legs>}`, where the legs are `"client":<n>`,
# `"server":<n>`, both in either order, or neither -- the CLI records none. `<n>`
# is a positive integer without a sign or a leading zero. Anything else is a
# release this cannot read and stops the run naming the release: a quoted
# number read as "no client leg" would check nothing and say it had, and a bare
# number is the shape the file had while there was one protocol, which nothing
# was ever published in.
read_release_history() {
  local component="$1" rest="$2" version legs leg client server
  local key_pattern='^"([^"]*)":' body_pattern='^[{]([^{}]*)[}]'
  local leg_pattern='^"(client|server)":([1-9][0-9]*)'
  MANIFEST_RELEASE_VERSIONS=''

  while [ -n "$rest" ]; do
    [[ "$rest" =~ $key_pattern ]] || die "$VERSIONS_SOURCE lists the $component releases in a shape this cannot read: each is \"<version>\":{<protocol legs>}"
    version="${BASH_REMATCH[1]}"
    rest="${rest#"${BASH_REMATCH[0]}"}"
    [[ "$version" =~ $RELEASE_VERSION ]] || die "$VERSIONS_SOURCE lists a $component release keyed $(quote "$version"), which is not a version"

    [[ "$rest" =~ $body_pattern ]] || die "$VERSIONS_SOURCE gives the $component release $version something other than its protocol legs, an object of positive integer client and server versions"
    legs="${BASH_REMATCH[1]}"
    rest="${rest#"${BASH_REMATCH[0]}"}"

    client=''
    server=''
    while [ -n "$legs" ]; do
      [[ "$legs" =~ $leg_pattern ]] || die "$VERSIONS_SOURCE gives the $component release $version a protocol leg this cannot read in $(quote "$legs"): the legs are client and server, each a positive integer"
      leg="${BASH_REMATCH[1]}"
      legs="${legs#"${BASH_REMATCH[0]}"}"
      case "$leg" in
        client)
          [ -z "$client" ] || die "$VERSIONS_SOURCE gives the $component release $version the client leg twice"
          client='yes'
          ;;
        server)
          [ -z "$server" ] || die "$VERSIONS_SOURCE gives the $component release $version the server leg twice"
          server='yes'
          ;;
      esac
      case "$legs" in
        '') ;;
        ,?*) legs="${legs#,}" ;;
        *) die "$VERSIONS_SOURCE gives the $component release $version a protocol leg this cannot read in $(quote "$legs"): the legs are client and server, each a positive integer" ;;
      esac
    done

    MANIFEST_RELEASE_VERSIONS="${MANIFEST_RELEASE_VERSIONS:+$MANIFEST_RELEASE_VERSIONS }$version"

    case "$rest" in
      '') ;;
      ,?*) rest="${rest#,}" ;;
      *) die "$VERSIONS_SOURCE lists the $component releases in a shape this cannot read after $version" ;;
    esac
  done
}

# Whether the history lists one release, as a status rather than a refusal, so
# every caller writes its own `|| die` naming what it was looking for. Split on
# the spaces `read_release_history` put there, and never globbed: every word
# has already matched RELEASE_VERSION, which admits no `*`, `?` or `[`.
release_listed() {
  local listed
  for listed in $MANIFEST_RELEASE_VERSIONS; do
    [ "$listed" != "$1" ] || return 0
  done
  return 1
}

# The release a component's entry calls current. Sets RESOLVED_VERSION.
read_versions_entry() {
  local component="$1"

  read_component_entry "$component"
  [[ "$MANIFEST_CURRENT" =~ $RELEASE_VERSION ]] || die "$VERSIONS_SOURCE gives $component the current version $(quote "$MANIFEST_CURRENT"), which is not a version this can install"
  RESOLVED_VERSION="$MANIFEST_CURRENT"
  release_listed "$RESOLVED_VERSION" || die "$VERSIONS_SOURCE calls $RESOLVED_VERSION the current $component and lists no such release beside it, and the release history is what says which versions of it exist"
}

# The newest release in one series, out of the versions a component's release
# history lists (MANIFEST_RELEASE_VERSIONS, already checked against the grammar
# and space separated), or nothing at all when the series holds none.
#
# **What counts as in the series.** A prefix at a dot boundary, with the
# remaining fields plain numbers: `1.3` takes `1.3.<patch>` and `1` takes
# `1.<minor>.<patch>`. Built as a pattern rather than tested as a string prefix
# so that `1.3` cannot match `1.30.0`, and so that a prerelease or a build
# suffix is excluded by the same expression that fixes the depth -- `hub@1.3`
# must not select `1.3.8-rc1`, because a series is how a fleet asks for the
# newest patch and a release candidate is not one. Naming `1.3.8-rc1` exactly
# still installs it: the release job records a prerelease in the manifest for
# that reason, and only keeps it from being what the file calls current.
#
# **Why the comparison is written out.** `sort -V` was the obvious reach and it
# is not used. It is there on both machines this was run against -- BSD sort
# 2.3-Apple on macOS 26 and GNU coreutils 9.1 in the debian:bookworm-slim the
# install tests use, agreeing on the ordering this needs -- but the loop that
# filters candidates is already a loop, and six lines of numeric compare inside
# it cost less than a claim about every sort on every machine this script is
# piped into. Nothing is spawned per candidate either way.
newest_in_series() {
  local versions="$1" series="$2" best='' key
  local number='(0|[1-9][0-9]*)' pattern
  case "$series" in
    *.*) pattern="^${series//./\\.}\.${number}$" ;;
    *) pattern="^${series}\.${number}\.${number}$" ;;
  esac

  # Split on the spaces `read_release_history` put there, and never globbed:
  # every word has already matched RELEASE_VERSION, which admits no `*`, `?`
  # or `[`.
  for key in $versions; do
    [[ "$key" =~ $pattern ]] || continue
    if [ -z "$best" ] || newer_version "$key" "$best"; then best="$key"; fi
  done

  printf '%s' "$best"
}

# Whether the first of two `<major>.<minor>.<patch>` versions is the newer.
#
# Field by field and numerically, which is the whole point: `1.3.10` is newer
# than `1.3.9` and sorts before it in every ordering that compares text. Only
# ever asked of two candidates `newest_in_series` has already matched against
# its pattern, so there are exactly three fields and each is digits.
newer_version() {
  local -a left right
  IFS='.' read -r -a left <<<"$1"
  IFS='.' read -r -a right <<<"$2"

  local index
  for index in 0 1 2; do
    if [ "${left[index]}" -gt "${right[index]}" ]; then return 0; fi
    if [ "${left[index]}" -lt "${right[index]}" ]; then return 1; fi
  done
  return 1
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

  die "no ${flat}-<version>.tgz in $AGENTPLEX_PACKAGE, and every role installs $1. A directory missing one of the packages a role needs would install the rest and quietly leave that one to a registry"
}

# The version the name npm packed a tarball under carries, or nothing when it is
# not a release version: `<flattened name>-<version>.tgz`, read the way
# `agentplex install` reads it, since the two are compared.
tarball_version() {
  local flat base version
  flat="${2#@}"
  flat="${flat//\//-}"
  base="$(basename "$1" .tgz)"
  version="${base#"$flat"-}"
  [[ "$version" =~ $RELEASE_VERSION ]] || return 0
  printf '%s' "$version"
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
# The answer is the unit's as well, which is the whole reason this is resolved
# rather than merely done: ExecStart names the interpreter outright, so the Node
# this settles on is the one systemd starts. `agentplex install` writes the unit
# and asks the same question the same way -- `resolveNodeDirectory` in
# `apps/cli/src/installation/node-directory.ts`, held to this by its suite --
# and gets the same answer, because it is run through the Node this function
# chose, on the PATH `ensure_node` put that Node at the front of.
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
  # is `#!/usr/bin/env node`, or starts one: npm, and agentplex, which is named
  # through this interpreter (see `run_cli`) and runs npm for every other
  # package. A Node unpacked into the prefix is on nobody's PATH yet, so
  # `$PREFIX/bin/npm` would resolve `node` to whatever the machine had, which is
  # the runtime this install exists because of: too old, or absent, and in the
  # first case it compiles a native addon against the wrong one and says
  # nothing. Captured here rather than reasoned about -- an end-to-end run with
  # a v20 shim ahead of PATH had npm's shebang find the shim, print its version
  # and exit 0, and the install then reported success with no binary anywhere.
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
  # the packages still go under $PREFIX/lib, and the prefix root also holds the
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
  # outright: root-owned is the whole point of keeping it out of what `agentplex
  # install` gives the service account, and an unrelated local user owning it
  # instead is the same hole with a stranger in it. Captured, not reasoned
  # about: the --system block asserts root over the whole of $PREFIX/node, and
  # read UNKNOWN there until this flag was on the line.
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

# The command's package, installed against the versions CI tested it with.
#
# The command's alone, because it is the one package that has to be here before
# anything but bash can install the rest. `agentplex install` then installs the
# role's other packages with the same step in TypeScript -- `installPackages`
# in `apps/cli/src/installation/package-install.ts` -- as one set that moves in
# whole or not at all.
#
# The tarball carries an `npm-shrinkwrap.json`: the third-party versions this
# build was tested against, transitive ones included. `npm install --global
# <tarball>` ignores it (AGX-322, Q8) and resolves every range afresh against
# whatever the registry calls newest that day, so two machines installed a week
# apart ran different code under one version number. npm reads a shrinkwrap only
# when the package is the project it installs into, so the tarball is unpacked
# first and npm is pointed at the unpacked directory.
#
# `npm install` and not `npm ci`, although `ci` is the command that sounds like
# this. `ci` deletes node_modules before it starts, which takes the bundled
# `@agentplex/*` packages with it, and then asks the registry for them under
# names nothing is published as -- E404 (AGX-322, Q1). `install` keeps what the
# tarball brought and fetches the rest at the shrinkwrap's versions.
#
# Staged beside the tree it replaces, as `<tree>.new`, so a failure while
# staging removes the `.new` and leaves the tree and the link the machine was
# running on untouched. The swap is two renames on one filesystem.
install_package() {
  local tree method
  tree="$(package_tree cli)"
  method="unpack into $tree.new; npm install --omit=dev in it, against the npm-shrinkwrap.json it carries; then move it into place and link $BIN_DIR/$PACKAGE_NAME -> $(command_link_target)"

  # The one shape the plan has two of, and the second one is a dry run that
  # declined to download. It names what would be installed and where from, and
  # not a URL it would have had to invent a version for.
  if [ -z "$CLI_SPEC" ]; then
    report 'package' "cli from $RELEASE_DOWNLOAD_URL into $PREFIX, at whatever version the line above resolves to"
    report 'method' "$method"
    return 0
  fi

  report 'package' "$CLI_SPEC into $PREFIX"
  report 'method' "$method"
  [ "$DRY_RUN" = 'no' ] || return 0

  local npm globalconfig work tarball
  npm="$(npm_command)"

  # The operator's global npmrc -- a registry mirror, a proxy, a CA bundle -- has
  # to reach the install below, and `--prefix` takes it away: npm looks for the
  # global config under the prefix it was given, so a staging directory's own
  # `etc/npmrc`, which does not exist (AGX-322, Q14). So the path is asked once
  # without `--prefix`, from `/` so that no project config the run happened to
  # start inside can answer, and handed back to the install.
  globalconfig="$(cd / && "$npm" config get globalconfig)" \
    || die "npm could not say where its global config is, so the install below could not be pointed at it"

  work="$(mktemp -d)"
  # A failure anywhere below, a `die` or a signal, takes back what this run
  # staged, so what is left is exactly what was there before it started.
  # shellcheck disable=SC2064
  trap "rm -rf '$work' '$tree.new'" EXIT

  recover_interrupted_swap

  # Unpacked before npm runs, so a download that fails or an archive that will
  # not unpack costs nothing but the fetch. --no-same-owner for the reason the
  # runtime's unpack gives: an archive's owner is the machine it was packed on,
  # and tar run as root would restore it.
  if [ -n "${AGENTPLEX_PACKAGE:-}" ]; then
    tarball="$CLI_SPEC"
  else
    tarball="$work/cli.tgz"
    say "downloading $CLI_SPEC"
    fetch "$CLI_SPEC" "$tarball" || die "could not download the cli package from $CLI_SPEC; nothing was installed"
  fi
  mkdir -p "$tree.new"
  tar -xzf "$tarball" -C "$tree.new" --strip-components=1 --no-same-owner \
    || die "could not unpack the cli package from $tarball; nothing was installed"

  # Every flag here was added by a probe, not by caution (AGX-322):
  #
  # --ignore-scripts=false rather than whatever the operator's npmrc says.
  # node-pty's install scripts are what compile the addon, and the pty package's
  # postinstall restores the executable bit the npm tarball drops from node-pty's
  # spawn-helper. An npmrc carrying ignore-scripts=true produces an install that
  # reports success and a service that cannot start, and that postinstall cannot
  # warn about it because it is disabled by the same setting.
  #
  # --package-lock=true because an npmrc `package-lock=false` makes npm ignore
  # the shrinkwrap altogether, and --no-save because npm otherwise rewrites the
  # shrinkwrap it read. --install-strategy=hoisted is the layout the shrinkwrap
  # was written in, whatever an npmrc prefers.
  #
  # Run from `/`, like the question above: --prefix is where it installs, and
  # the directory this script was started in has no say.
  (cd / && "$npm" install --prefix "$tree.new" --globalconfig="$globalconfig" \
    --omit=dev --ignore-scripts=false --package-lock=true --no-save \
    --install-strategy=hoisted --no-audit --no-fund) \
    || die "npm could not install the cli package ($NPM_PACKAGE) into $tree.new; it was removed and the installed one was left as it was"

  rm -rf "$tree.old"
  if [ -e "$tree" ]; then
    mv "$tree" "$tree.old"
  fi
  mv "$tree.new" "$tree"
  rm -rf "$tree.old"

  rm -rf "$work"
  trap - EXIT

  # The link npm used to make, made the way npm makes it: relative, so the
  # prefix can be read from any path it is reached by. npm also sets the
  # target's executable bit as it links it, and a hand-made link has to as well
  # -- the tarball packs the entry `-rw-r--r--`, and a link to it is
  # `Permission denied` (AGX-322, Q6).
  mkdir -p "$BIN_DIR"
  chmod 0755 "$tree/$CLI_ENTRYPOINT"
  ln -sfn "$(command_link_target)" "$BIN_DIR/$PACKAGE_NAME"

  [ -x "$BIN_DIR/$PACKAGE_NAME" ] || die "installed the package and there is no $BIN_DIR/$PACKAGE_NAME to run"
}

# Where one component's package lives under the prefix: npm's layout for a
# global package, which `agentplex install` and `uninstall_package` also name.
package_tree() {
  printf '%s/lib/node_modules/%s' "$PREFIX" "$(component_package "$1")"
}

# What the command's link in the prefix's bin points at, relative to that bin.
command_link_target() {
  printf '../lib/node_modules/%s/%s' "$NPM_PACKAGE" "$CLI_ENTRYPOINT"
}

# What a run killed partway left of the command's tree, put right before
# anything is staged.
#
# A `.new` is a staging nobody finished, and is discarded. A `.old` beside its
# tree is a swap that got as far as the second rename, and is discarded too. A
# `.old` with no tree beside it is the one that matters: the run was killed
# between the two renames, and the machine's command is intact under a name
# nothing starts. It goes back, so a failure below still leaves the machine
# with the command it had. The command's tree only, because it is the one this
# step stages: `agentplex install` puts back the others before it stages its
# own set.
recover_interrupted_swap() {
  local tree
  tree="$(package_tree cli)"
  rm -rf "$tree.new"
  [ -e "$tree.old" ] || return 0
  if [ -e "$tree" ]; then
    rm -rf "$tree.old"
  else
    mv "$tree.old" "$tree"
    say "restored $tree, which an interrupted install had set aside as $tree.old"
  fi
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
#
# `resolveNpm` in `apps/cli/src/installation/package-install.ts` is the same
# rule for the same reason, and bash keeps its own because this one runs before
# there is a bin to ask.
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
# The units, which are the command's
# ---------------------------------------------------------------------------

# The unit file a daemon gets: agentplex-hub.service, agentplex-server.service.
# `agentplex install` writes them; --uninstall and the summary look for them.
unit_file() {
  echo "$UNIT_DIR/${PACKAGE_NAME}-$1.service"
}

# Whether this machine can hold a systemd unit at all. macOS has no systemd,
# and a container may have none.
#
# The answer is a reason rather than a yes or a no, and the two reasons stay
# apart because they send the operator to different places: macOS wants
# launchd, and a Linux box without systemctl wants systemd installed or the
# daemon started by hand. `agentplex install` asks the same question before it
# writes a unit, in the same words; this is asked for the units --uninstall has
# to stop and for what the summary says.
resolve_unit_support() {
  if [ "$PLATFORM" != 'linux' ]; then
    UNIT_SKIP_REASON='macOS has no systemd, hand the process to launchd'
  elif ! have systemctl; then
    UNIT_SKIP_REASON='no systemctl on this machine'
  fi
}

# `--print-unit`, which this script answers by asking the command.
#
# The units are rendered in one place now, `renderUnit` in the command, and the
# command answers `--print-unit` for the same arguments. It asks nothing but
# which interpreter the units name, so it still reaches no network. What it
# needs is the command in the prefix and a Node to run it on; without them there
# is nothing here to render with, and the run stops naming the command that
# renders them rather than printing a unit out of a second copy of the template.
print_units() {
  local command
  command="$BIN_DIR/$PACKAGE_NAME install --print-unit$(typed_arguments)"

  [ -f "$(cli_entry)" ] || die "the units are rendered by $command, and there is no $PACKAGE_NAME in $PREFIX to run it with. Install first -- this script without --print-unit -- or run that command on a machine where $PACKAGE_NAME is installed"
  [ -x "$NODE_DIR/node" ] || die "the units are rendered by $command, and there is no Node of v${NODE_MAJOR} or better here to run it on. Install first -- this script without --print-unit -- and run it again"

  run_cli install --print-unit ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
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
# Handing over to agentplex install
# ---------------------------------------------------------------------------

# The command's entry in the prefix: the file the link in the prefix's bin
# points at, and what the rest of the install runs as.
cli_entry() {
  printf '%s/%s' "$(package_tree cli)" "$CLI_ENTRYPOINT"
}

# The operator's own arguments, as typed, each after a space -- or nothing.
typed_arguments() {
  [ "${#INSTALL_ARGS[@]}" -eq 0 ] || printf ' %s' "${INSTALL_ARGS[@]}"
}

# The command, run through the interpreter this run settled on.
#
# Named outright rather than as $BIN_DIR/agentplex, whose first line is
# `#!/usr/bin/env node` and would search a PATH for its interpreter -- the
# search `ensure_node` has a captured note about, where a v20 shim ahead of
# PATH answered it. The PATH is this run's, which `ensure_node` already put the
# runtime at the front of, and every variable this run was started with goes
# with it: AGENTPLEX_VERSIONS and AGENTPLEX_PACKAGE are the command's seams as
# well as this script's, and it reads them for the rest of the install.
#
# stdin is /dev/null, for the reason `run_setup` gives at length: under
# `curl | bash` this script is bash's stdin, and a child that read it would eat
# the rest of the script.
run_cli() {
  "$NODE_DIR/node" "$(cli_entry)" "$@" </dev/null
}

# Whether the prefix already holds the command this run would install, runnable.
#
# The version is read out of the package's own manifest and parsed: a word off a
# disk is a claim, and one that is not a version is a command this cannot say
# anything about. Every way of not knowing answers no, which is the direction
# that does not over-claim -- a dry run that could have asked and did not says
# so, and one that asked a command at some other version would print the plan
# of a different install.
installed_cli_is() {
  local wanted="$1" manifest version
  [ -n "$wanted" ] || return 1
  [ -x "$NODE_DIR/node" ] || return 1
  [ -f "$(cli_entry)" ] || return 1
  manifest="$(package_tree cli)/package.json"
  [ -f "$manifest" ] || return 1
  version="$(json_string "$(flatten_json "$(cat "$manifest")")" 'version')" || return 1
  [[ "$version" =~ $RELEASE_VERSION ]] || return 1
  [ "$version" = "$wanted" ]
}

# The rest of the install, which is `agentplex install`'s.
#
# The command resolves and installs the role's other packages, checks that they
# agree on each protocol leg, gives the service account the directories it
# writes into, and writes the settings file and a unit per daemon, never
# started. It is handed exactly what the operator typed, so a word the two
# grammars read differently cannot be an install that means one thing typed at
# the script and another once the script hands over.
#
# **A dry run** installed nothing above, so on a first run there is no command
# to ask. What it can say is which command would plan the rest, with the
# arguments it would be given; running the command out of a tarball without
# installing it would need its dependencies installed, and that is an install.
# On a re-run the command is already here, and when it is the version this run
# would leave, it is asked for its half of the plan.
#
# **A real run** has just put the command there. A pin can name a release older
# than the handover, so the command is asked first whether it has `install`,
# and a command that does not is named rather than run into a usage error the
# operator did not know they were asking for.
hand_over() {
  local command
  if [ "$DRY_RUN" = 'yes' ]; then
    command="$BIN_DIR/$PACKAGE_NAME install --dry-run$(typed_arguments)"
    if installed_cli_is "$CLI_VERSION"; then
      report 'install' "$command"
      say ''
      run_cli install --dry-run ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
      say ''
      return 0
    fi

    local why="$PREFIX holds no $PACKAGE_NAME $CLI_VERSION to run it with yet"
    [ -n "$CLI_VERSION" ] || why='this dry run resolved no version of it to look for'
    report 'install' "not run: $command plans the rest once $PACKAGE_NAME is installed -- the role's other packages, the settings file and the units -- and $why"
    return 0
  fi

  local version="${CLI_VERSION:-from $CLI_SPEC}"
  run_cli install --help >/dev/null 2>&1 || die "the $PACKAGE_NAME $version this installed has no \`install\` command, and everything after the runtime is that command's now. Pin --package-version to a release that has \`$PACKAGE_NAME install\`. $PACKAGE_NAME itself is at $BIN_DIR/$PACKAGE_NAME; nothing else was installed"

  command="$BIN_DIR/$PACKAGE_NAME install$(typed_arguments)"
  report 'install' "$command"
  say ''

  local status='0'
  run_cli install ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} || status="$?"
  say ''

  if [ "$status" != '0' ]; then
    say "$PACKAGE_NAME install exited $status, and what it said is above. $PACKAGE_NAME itself is"
    say "installed at $BIN_DIR/$PACKAGE_NAME, so this can be run again once that is dealt with,"
    say "and \`$BIN_DIR/$PACKAGE_NAME doctor\` reads what is here."
    exit "$status"
  fi
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
# the packages it installed, two unit files it rendered -- and every one of them
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

# The packages this script installed, and the link it made in the prefix's bin.
#
# A package directory under $PREFIX/lib/node_modules is the marker as much as
# the target: one is there because this script unpacked it there, and a prefix
# with none of them is not a prefix this script installed into. That is what keeps a mistyped `--uninstall --prefix=/usr/local`
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
#
# The `<package>.new` and `<package>.old` an interrupted install left go too, and
# count as a marker: they are named for our packages, and nothing but
# `install_package` writes them. A first install killed while staging leaves
# nothing else, and "nothing to remove" would be untrue about it. They are
# listed after every tree, so the first line is still a package when there is
# one.
uninstall_package() {
  local suffix component path found='no'

  for suffix in '' .new .old; do
    for component in $COMPONENTS; do
      path="$(package_tree "$component")$suffix"
      [ -e "$path" ] || continue
      found='yes'
      report 'package' "remove $path"
      [ "$DRY_RUN" = 'no' ] || continue
      rm -rf "$path"
    done
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
    say "Nothing will start ${PACKAGE_NAME} for you, so run each daemon yourself once"
    say "$ENV_FILE is complete. The command is each unit's ExecStart line, which"
    # The units are the command's to render, on any machine, so this names the
    # command that prints them rather than keeping a second copy of the line
    # here. An operator handing a daemon to launchd needs the literal argv, and
    # this is where it comes from: the interpreter and the daemon's own file,
    # because there is no command for a daemon to type.
    say "  $BIN_DIR/$PACKAGE_NAME install --print-unit$(typed_arguments)"
    say 'prints. What to hand it to instead -- launchd on macOS -- is in the documentation below.'
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
      # `agentplex start` reads that off the settings file `agentplex install`
      # wrote -- the same file, the same branch that chose the unit directory --
      # and does both steps. `agentplex setup` runs it at the end of a successful run, so
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
