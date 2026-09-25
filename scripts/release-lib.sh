#!/bin/bash
# Release-directory mechanics for issue #1391 — sourced by the deploy scripts
# (scripts/deploy.sh, scripts/deploy-ru-edge.sh) and by tests.
#
# Prod is not a git working tree any more: a release is an immutable snapshot of
# a commit, built outside the session worktree, and the running version is chosen
# by atomically repointing a symlink. A session doing checkout/commit can no
# longer change what is served.
set -Eeuo pipefail

# SUDO is overridable so the mechanics can be exercised without root in tests.
# Use ${SUDO-sudo} (not :-) so an explicit empty SUDO stays empty.
SUDO="${SUDO-sudo}"

# release_build <repo> <target-sha> <releases-dir>
# Materialises <releases-dir>/<sha> from the commit via `git archive` + `npm ci`.
# Idempotent: an already-completed release is reused. Builds in a staging dir and
# atomically renames it into place so a half-built release is never activated.
release_build() {
  local repo="$1" target="$2" releases="$3"
  local dir="$releases/$target" staging="$releases/.staging-$target-$$"

  if [ -f "$dir/.release-complete" ]; then
    echo "release $dir already built" >&2
    return 0
  fi

  echo "==> Building release $dir" >&2
  $SUDO rm -rf "$staging" "$dir"
  $SUDO mkdir -p "$staging"
  git -C "$repo" archive "$target" | $SUDO tar -x -C "$staging"

  if [ "${RELEASE_SKIP_DEPS:-}" = "1" ]; then
    echo "  RELEASE_SKIP_DEPS=1 — skipping npm ci" >&2
  else
    $SUDO -H npm ci --prefix "$staging" --omit=dev >&2
  fi

  $SUDO touch "$staging/.release-complete"
  $SUDO mkdir -p "$releases"
  # `mv -T` is GNU; fall back to rm+mv where it is unsupported (BSD/macOS tests).
  $SUDO mv -T "$staging" "$dir" 2>/dev/null || { $SUDO rm -rf "$dir"; $SUDO mv "$staging" "$dir"; }
}

# release_set_link <link> <target-dir>
# Atomically repoints <link> at <target-dir> (symlink swap via rename).
release_set_link() {
  local link="$1" target="$2" tmp="$1.new.$$"
  $SUDO ln -sfn "$target" "$tmp"
  if [ "$(uname -s)" = "Darwin" ]; then
    $SUDO mv -h "$tmp" "$link"
  else
    $SUDO mv -T "$tmp" "$link"
  fi
}

# release_gc <releases-dir> [keep]
# Keeps the newest <keep> releases (default 3) so rollback and the current
# version always survive; removes older ones. Staging dirs and the shared
# trained-assist-hh-skill sibling symlink are never removed.
release_gc() {
  local releases="$1" keep="${2:-3}"
  local d
  for d in "$releases"/.staging-*; do
    [ -e "$d" ] || continue
    echo "==> GC stale staging dir $d" >&2
    $SUDO rm -rf "$d"
  done
  # shellcheck disable=SC2012
  ls -1dt "$releases"/*/ 2>/dev/null \
    | grep -v '/\.staging-' \
    | grep -v '/trained-assist-hh-skill/$' \
    | tail -n +"$((keep + 1))" \
    | while read -r d; do
        echo "==> GC old release $d" >&2
        $SUDO rm -rf "$d"
      done
}
