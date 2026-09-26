#!/usr/bin/env bash
#
# advance-v1.sh <component> <version> <protocol> <sha> <remote>
#
# <protocol> is the JSON text of the released package's `agentplex.protocol`,
# the legs it speaks: `{"client":39,"server":39}` for a hub, `{}` for the CLI.
# It is passed through to the manifest writer untouched and parsed there.
#
# Records one release in `versions.json` on the `v1` branch of <remote>, and
# moves the branch's tree to the released commit when that is safe. Run by the
# release workflow's `v1` job from its checkout of the tagged commit, which has
# to carry full history: the guards below are ancestry questions.
#
# Four things decide the shape of this script.
#
# **Several releases write the branch at once.** Tags for different components
# run as independent workflows, so two jobs can both read `v1` before either
# pushes. The push is never forced, so the one that reads a stale head is
# refused, and the answer is to read the branch again and rebuild on top of it
# rather than to lose the release: `versions.json` is append-only, and a
# release missing from it is a pin nobody can install. A concurrency group
# does not do this -- GitHub keeps one pending job per group and cancels the
# older pending ones, so four tags pushed together would lose entries. Any
# refused push is retried, because a lost race does not always read as
# "non-fast-forward": a ref that moved while the push was in flight reads as
# "failed to update ref".
#
# **The tree only moves forward along master.** `install.sh` is what every
# `curl | bash` fetches from this branch, so a tag cut from a commit that is
# not on master, or from one older than the tree the branch already has, must
# not become that script. Such a release is still recorded in the manifest --
# it was published, and `--role=<component>@<version>` has to be able to find
# it -- and the tree stays where it was. The commit a tree came from is written
# as a `Released-From` trailer and searched for rather than read off the head,
# because a commit that did not move the tree carries none. A branch with no
# trailer anywhere is the branch as the job before this script left it, and
# the one guard left for it is master.
#
# **A prerelease records itself and keeps the tree**, for the same reason: the
# script the documented one-liner hands out is the last full release's. The
# exception is a branch that does not exist yet, where the tagged tree is the
# only one there is.
#
# **Nothing in the running checkout moves.** The commit is built with plumbing
# against a private index and pushed by id, so the job's working tree, its
# HEAD and its branches are exactly as the checkout left them, and the refs
# this fetches live under a namespace of their own that is removed on exit.

set -euo pipefail

usage() {
  echo 'usage: advance-v1.sh <component> <version> <protocol> <sha> <remote>' >&2
  exit 64
}

[ "$#" -eq 5 ] || usage
component=$1
version=$2
protocol=$3
requested=$4
remote=$5

scripts_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
manifest_writer="$scripts_directory/versions-manifest.ts"

# Its own identity rather than the checkout's config: a runner has none, and a
# commit made under whatever `user.name` a machine happens to carry would say
# somebody made a release who did not.
export GIT_AUTHOR_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

attempts=5
backoff=${ADVANCE_V1_BACKOFF_SECONDS:-5}
case "$backoff" in
  '' | *[!0-9]*)
    echo "advance-v1: ADVANCE_V1_BACKOFF_SECONDS is not a number of seconds: $backoff" >&2
    exit 64
    ;;
esac

fail() {
  echo "advance-v1: $*" >&2
  exit 1
}

if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
  fail 'this checkout is shallow, and every guard here is a question about ancestry; check out with full history'
fi

sha=$(git rev-parse --verify --quiet "$requested^{commit}") ||
  fail "$requested is not a commit in this repository"

prerelease='no'
case "$version" in *-*) prerelease='yes' ;; esac

namespace='refs/advance-v1'
work=$(mktemp -d "${TMPDIR:-/tmp}/advance-v1.XXXXXX")
cleanup() {
  rm -rf "$work"
  git update-ref -d "$namespace/v1" 2>/dev/null || :
  git update-ref -d "$namespace/master" 2>/dev/null || :
}
trap cleanup EXIT

# `merge-base --is-ancestor` answers 1 for "no" and something else for "could
# not tell", and only the first is an answer: an unknown commit is not a commit
# that is off master.
is_ancestor() {
  local status=0
  git merge-base --is-ancestor "$1" "$2" || status=$?
  case "$status" in
    0) return 0 ;;
    1) return 1 ;;
    *) fail "could not tell whether $1 is an ancestor of $2" ;;
  esac
}

# The commit the branch's tree was last taken from, or nothing when no commit
# in its first-parent history says. A value that is not one commit id is a
# trailer somebody wrote by hand, and guessing past it could move the tree
# backwards.
recorded_source() {
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [[ "$line" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
      printf '%s\n' "$line"
      return 0
    fi
    fail "v1 carries a Released-From trailer that is not one commit id: $line"
  done < <(git log --first-parent --format='%(trailers:key=Released-From,valueonly,separator=%x2C)' "$namespace/v1")
}

tag="$component-v$version"

attempt=1
while :; do
  # What the remote has now. Read again on every attempt, since a refused push
  # means somebody else moved the branch after the last read.
  has_v1='yes'
  listed=0
  git ls-remote --exit-code "$remote" refs/heads/v1 >/dev/null || listed=$?
  case "$listed" in
    0) ;;
    2) has_v1='no' ;;
    *) fail "could not list the branches of $remote" ;;
  esac
  refspecs=("+refs/heads/master:$namespace/master")
  if [ "$has_v1" = 'yes' ]; then refspecs+=("+refs/heads/v1:$namespace/v1"); fi
  git fetch --quiet --no-tags "$remote" "${refspecs[@]}"

  on_master='no'
  if is_ancestor "$sha" "$namespace/master"; then on_master='yes'; fi

  # Whether this release's tree becomes the branch's, and why not when it does
  # not -- the why goes in the commit, where somebody asking why install.sh did
  # not move will look.
  take_tree='no'
  held=''
  if [ "$has_v1" = 'no' ]; then
    [ "$on_master" = 'yes' ] ||
      fail "v1 does not exist yet and $sha is not on master, so there is no tree to keep and none that may be taken"
    take_tree='yes'
  elif [ "$prerelease" = 'yes' ]; then
    held='it is a prerelease'
  elif [ "$on_master" = 'no' ]; then
    held="$sha is not on master"
  else
    recorded=$(recorded_source)
    if [ -z "$recorded" ] || is_ancestor "$recorded" "$sha"; then
      take_tree='yes'
    else
      held="$sha does not descend from $recorded, the commit this branch's tree came from"
    fi
  fi

  previous=()
  if [ "$has_v1" = 'yes' ] && git cat-file -e "$namespace/v1:versions.json" 2>/dev/null; then
    git show "$namespace/v1:versions.json" >"$work/previous.json"
    previous=("$work/previous.json")
  fi
  node "$manifest_writer" "$component" "$version" "$protocol" ${previous[@]+"${previous[@]}"} >"$work/versions.json"

  index="$work/index"
  rm -f "$index"
  if [ "$take_tree" = 'yes' ]; then
    GIT_INDEX_FILE="$index" git read-tree "$sha"
  else
    GIT_INDEX_FILE="$index" git read-tree "$namespace/v1"
  fi
  blob=$(git hash-object -w "$work/versions.json")
  GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$blob,versions.json"
  tree=$(GIT_INDEX_FILE="$index" git write-tree)

  if [ "$has_v1" = 'yes' ]; then parent="$namespace/v1"; else parent="$sha"; fi

  if [ "$take_tree" = 'yes' ]; then
    subject="$component $version: the installer and the manifest for the released commit"
    body="$tag published $component at $version, declaring protocol $protocol.
This branch is what \`curl | bash\` fetches install.sh from and what an
install reads versions.json from, so both move to the commit the release
was cut from."
  else
    subject="$component $version: recorded in the manifest, without moving the tree"
    body="$tag published $component at $version, declaring protocol $protocol.
It is listed in versions.json so that --role=$component@$version can
install it. The tree is untouched, because $held: install.sh on this
branch stays the one from the last release that moved it."
  fi
  {
    printf '%s\n\n%s\n' "$subject" "$body"
    if [ "$take_tree" = 'yes' ]; then printf '\nReleased-From: %s\n' "$sha"; fi
  } >"$work/message"
  commit=$(git commit-tree "$tree" -p "$parent" -F "$work/message")

  # No --force: the parent is the head this attempt read, so a push that is
  # not a fast-forward is a branch that moved, and the server refusing it is
  # the guard.
  if git push --quiet "$remote" "$commit:refs/heads/v1"; then
    break
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    fail "v1 was refused $attempts times; $tag is not in versions.json"
  fi
  # Staggered, so that jobs refused together do not all read and push again
  # in the same instant.
  delay=$((backoff * attempt + RANDOM % (backoff + 1)))
  echo "advance-v1: push $attempt of $attempts refused; reading v1 again in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done

cat "$work/versions.json"
echo "advance-v1: v1 is $commit ($subject)"
