#!/usr/bin/env bash
# bb-factory release gate.
#
# Runs the full verification suite, rebuilds dist/, and stages the bundles for
# a release commit. It then prints the remaining commit, tag, and push
# commands instead of running them: a human finishes every release.
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
# artifacts bb would build.
git add -f dist/

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

cat <<EOF

Gate passed and dist/ is staged. Finish the release by hand:

  git commit -m "release: ${TAG} dist artifacts"
  git tag -a ${TAG} -m "bb-factory ${TAG}"
  git push origin ${BRANCH}
  git push origin ${TAG}

Installable afterwards with:

  bb plugin install git:github.com/adam-tracht/bb-factory@${TAG}
EOF
