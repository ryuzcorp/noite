#!/bin/sh
# The dev stack's Void sandbox controller bundle (SPEC, Void sandbox
# controller). `docker/dev.sh` runs it inside the one Noite container:
#
#   dev-sandbox.sh --source DIR --work DIR --bundle DIR --once
#   dev-sandbox.sh --source DIR --work DIR --bundle DIR --watch [--poll N]
#
# The runner loads `worker.js` + `meta.json` from `VOID_SANDBOX_BUNDLE_DIR` at
# every deploy (`host/void_sandbox.rs`), and only the release image bakes that
# bundle. Leaving the build to the developer meant a fresh (or updated)
# checkout failed every sandbox app's deploy at `celld deploy` with "sandbox
# controller bundle incomplete", so the dev stack owns it: `--once` builds
# before the runner starts, `--watch` rebuilds whenever the mounted package
# changes, and the next deploy picks the new bundle up with no manual step.
#
# The package is mounted read-only: its sources are copied into the work dir
# and its dependencies installed there from the package's own lockfile (the
# same `bun install --frozen-lockfile` the image build runs). Every build
# publishes a complete bundle by swapping a symlink with one rename, so a
# deploy never reads a half-written `worker.js`/`meta.json` pair. Runs only in
# the dev container (Debian: `mv -T`, `sha256sum`, `xargs -0`).
set -eu

usage() {
  cat <<'EOF'
usage: dev-sandbox.sh --source DIR --work DIR --bundle DIR --once|--watch [--poll N]

  --source DIR  the mounted package (apps/void-sandbox; read-only)
  --work DIR    writable tree: the source copy, its node_modules, builds
  --bundle DIR  published bundle path (VOID_SANDBOX_BUNDLE_DIR); this script
                owns it and keeps it a symlink
  --once        build when the sources moved past the last build, then exit
  --watch       the same, then rebuild on every source change
  --poll N      seconds between source checks (default 2)
EOF
}

source_dir=
work_dir=
bundle_dir=
mode=
poll=2
while [ $# -gt 0 ]; do
  case "$1" in
  --source) source_dir=${2:?--source needs a directory}; shift 2 ;;
  --work) work_dir=${2:?--work needs a directory}; shift 2 ;;
  --bundle) bundle_dir=${2:?--bundle needs a directory}; shift 2 ;;
  --once) mode=once; shift ;;
  --watch) mode=watch; shift ;;
  --poll) poll=${2:?--poll needs seconds}; shift 2 ;;
  -h | --help) usage; exit 0 ;;
  *)
    echo "dev-sandbox: unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
done
if [ -z "$source_dir" ] || [ -z "$work_dir" ] || [ -z "$bundle_dir" ] || [ -z "$mode" ]; then
  usage >&2
  exit 2
fi

# Both paths are ours to create and delete under: refuse anything relative, the
# filesystem root, or a bundle inside the work tree (the publish renames over
# `--bundle` and the prune runs under `--work`, so an overlap could delete the
# published bundle or the build it points at).
require_dev_path() {
  if [ "${2#/}" = "$2" ]; then
    echo "dev-sandbox: $1 must be an absolute path: $2" >&2
    return 1
  fi
  if [ "$2" = / ]; then
    echo "dev-sandbox: $1 must name a directory this script owns, not /" >&2
    return 1
  fi
}
require_dev_path --work "$work_dir" || exit 2
require_dev_path --bundle "$bundle_dir" || exit 2
case "$bundle_dir/" in
"$work_dir"/*)
  echo "dev-sandbox: --bundle must not live inside --work ($bundle_dir in $work_dir)" >&2
  exit 2
  ;;
esac

# The published path is a symlink this script swaps. A real directory there is
# a stale layout (or someone's bind mount) `mv -T` cannot replace, so refuse
# instead of deleting what may not be ours.
if [ -e "$bundle_dir" ] && [ ! -L "$bundle_dir" ]; then
  echo "dev-sandbox: $bundle_dir is a directory, not the published symlink; remove it and restart the dev stack" >&2
  exit 1
fi
gens="$work_dir/gens"
mkdir -p "$gens" "$(dirname "$bundle_dir")"

# Everything the bundle is built from: the entry, the bundler, `src/`, the
# bundler's own config and the dependency pins. Content, not timestamps, so an
# editor's atomic save and a checkout whose mtimes moved both count exactly
# when the bytes changed.
sources_digest() {
  (
    cd "$source_dir" &&
      find worker.ts build.ts src package.json bun.lock tsconfig.json \
        -type f -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum |
      sha256sum |
      cut -d' ' -f1
  )
}

# What the install is keyed on. The image build installs from these same two
# files, and a `package.json` edit with a stale `bun.lock` must re-run
# `--frozen-lockfile` so it fails loudly instead of building against the old
# tree.
deps_digest() {
  (
    cd "$source_dir" &&
      sha256sum package.json bun.lock |
      sha256sum |
      cut -d' ' -f1
  )
}

require_sources() {
  for path in worker.ts build.ts src package.json bun.lock tsconfig.json; do
    if [ ! -e "$source_dir/$path" ]; then
      echo "dev-sandbox: $source_dir/$path is missing; is apps/void-sandbox mounted?" >&2
      return 1
    fi
  done
}

# NOTE: `set -e` is suspended inside a function called from an `if`, `!` or
# `&&` context, so every multi-step function chains its steps with `&&`: a
# failed step must still abort the function with a non-zero status.
sync_sources() {
  rm -rf "$work_dir/src" &&
    cp -a "$source_dir/src" "$source_dir/worker.ts" "$source_dir/build.ts" \
      "$source_dir/package.json" "$source_dir/bun.lock" \
      "$source_dir/tsconfig.json" "$work_dir/"
}

install_deps() {
  stamp="$work_dir/.deps"
  current=$(deps_digest)

  if [ -d "$work_dir/node_modules" ] && [ -f "$stamp" ] &&
    [ "$(cat "$stamp")" = "$current" ]; then
    return 0
  fi
  echo "dev-sandbox: bun install (sandbox controller)"
  (
    cd "$work_dir" && bun install --frozen-lockfile
  ) &&
    printf '%s\n' "$current" >"$stamp"
}

# Build into a fresh generation and point the bundle path at it with one
# rename, then drop the generations nothing can still be reading: the new one
# and the one a deploy may have resolved before the swap (`prev`). A deploy
# reads `worker.js` and `meta.json` from one generation or the other, never from
# a build in flight and never from a directory this pruned from under it.
#
# The rename needs a symlink on both sides (`rename(2)` refuses a directory over
# a non-directory), and that link carries this writer's PID: a fixed name would
# let two publishers move each other's link into place.
publish_bundle() {
  gen=$(mktemp -d "$gens/gen.XXXXXX") || return 1
  prev=$(readlink "$bundle_dir" 2>/dev/null || :)
  if ! cp -a "$work_dir/dist/." "$gen/" ||
    ! ln -s "$gen" "$gens/link.$$" ||
    ! mv -T "$gens/link.$$" "$bundle_dir"; then
    rm -rf "$gen" "$gens/link.$$"
    return 1
  fi
  for old in "$gens"/gen.*; do
    if [ -d "$old" ] && [ "$old" != "$gen" ] && [ "$old" != "$prev" ]; then
      rm -rf "$old"
    fi
  done
}

build_bundle() {
  digest=$1
  sync_sources &&
    install_deps &&
    (
      cd "$work_dir" && bun ./build.ts
    ) &&
    publish_bundle &&
    printf '%s\n' "$digest" >"$work_dir/.sources"
}

# The bundle is due when it is not published (fresh container) or the sources
# moved past the build that produced it.
needs_build() {
  if [ ! -f "$bundle_dir/worker.js" ] || [ ! -f "$bundle_dir/meta.json" ]; then
    return 0
  fi
  [ "$(cat "$work_dir/.sources" 2>/dev/null || :)" != "$1" ]
}

build_or_report() {
  if build_bundle "$1"; then
    echo "dev-sandbox: published the controller bundle at $bundle_dir"
    return 0
  fi
  # A failed build leaves no current bundle. Keeping the previous one would let
  # a deploy run the controller from bytes the sources no longer have, which is
  # how a dev session silently ships stale sandbox code; withdraw it so the
  # verify-then-publish contract of `load_bundle` holds.
  if [ -L "$bundle_dir" ]; then
    rm -f "$bundle_dir"
    echo "dev-sandbox: withdrew the stale controller bundle at $bundle_dir" >&2
  fi
  echo "dev-sandbox: sandbox controller build failed; fix the error above — a sandbox app deploy fails until it builds" >&2
  return 1
}

require_sources

if [ "$mode" = once ]; then
  digest=$(sources_digest)
  if needs_build "$digest"; then
    build_or_report "$digest" || exit 1
  else
    echo "dev-sandbox: controller bundle current at $bundle_dir"
  fi
  exit 0
fi

# Watch: build once if needed, then keep the bundle matched to the sources.
# `attempted` is the digest of the last build attempt whether it succeeded or
# failed, so a broken edit is not retried until the sources change (a failed
# build must never spin the container); the published bundle is withdrawn while
# the sources do not build.
attempted=$(sources_digest)
if needs_build "$attempted"; then
  build_or_report "$attempted" || :
else
  echo "dev-sandbox: controller bundle current at $bundle_dir"
fi
while :; do
  sleep "$poll"
  if ! next=$(sources_digest); then
    continue
  fi
  if [ "$next" = "$attempted" ]; then
    continue
  fi
  echo "dev-sandbox: sources changed; rebuilding the controller bundle"
  attempted=$next
  build_or_report "$next" || :
done
