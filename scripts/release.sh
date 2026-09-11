#!/usr/bin/env bash
# bb-factory release gate.
#
# Runs the full verification suite, rebuilds dist/, and assembles the release
# commit on local main (tree minus plans/, plus dist/) with its tag. It then
# prints the push commands instead of running them: a human pushes every
# release.
#
# Usage: pnpm release
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is not clean; commit or stash everything first" >&2
  git status --short >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

if git rev-parse --quiet --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "release: tag ${TAG} already exists; bump version in package.json" >&2
  exit 1
fi

echo "==> pnpm test"
pnpm test
echo "==> pnpm typecheck"
pnpm typecheck
echo "==> pnpm lint"
pnpm lint
echo "==> bb plugin types --check ."
bb plugin types --check .
echo "==> pnpm build"
pnpm build

# dist/ stays gitignored during development; release commits carry the
# prebuilt bundles so tag checkouts and npm-source installs ship the same
# artifacts bb would build. Release commits live only on main: their tree
# is this tree minus plans/ (this repository's own factory protocol is
# working state, not shipped product) plus the dist/ bundles. The commit
# is assembled in a scratch index so the worktree stays untouched, and
# local main is advanced to it for the human push.
git fetch origin main

TMP_INDEX="$(mktemp)"
trap 'rm -f "$TMP_INDEX"' EXIT
export GIT_INDEX_FILE="$TMP_INDEX"
git read-tree HEAD
git rm -r -q --cached plans 2>/dev/null || true
git add -f dist/
RELEASE_TREE="$(git write-tree)"
unset GIT_INDEX_FILE

MAIN_PARENT="$(git rev-parse --verify -q origin/main || true)"
if [ -n "$MAIN_PARENT" ]; then
  RELEASE_COMMIT="$(git commit-tree "$RELEASE_TREE" -p "$MAIN_PARENT" -m "release: ${TAG} dist artifacts")"
else
  RELEASE_COMMIT="$(git commit-tree "$RELEASE_TREE" -m "release: ${TAG} dist artifacts")"
fi
git update-ref refs/heads/main "$RELEASE_COMMIT"
git tag -a "$TAG" -m "bb-factory ${TAG}" "$RELEASE_COMMIT"

cat <<EOF

Gate passed. Release commit ${RELEASE_COMMIT} is on local main, tagged
${TAG}. Finish the release by hand:

  git push origin main
  git push origin ${TAG}

Installable afterwards with:

  bb plugin install git:github.com/adam-tracht/bb-factory@${TAG}
EOF
