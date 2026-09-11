# Releasing bb-factory

bb-factory is distributed as a git source. bb resolves release tags named
`vX.Y.Z` repository-wide, so a release is a pushed tag on a commit that
carries the built plugin.

## dist strategy

`dist/` stays gitignored during development. For git-source installs bb runs
`npm install` and rebuilds the bundles itself (a committed `dist/` is
replaced), while npm-source installs require a metadata-validated prebuilt
bundle. Shipping `dist/` in the release commit keeps the tag install-ready
for both source kinds and matches what CI built. The release script
force-adds it.

## Steps

1. On the release branch with a clean tree, bump `version` in package.json
   and commit that normally.
2. Run `pnpm release` (`scripts/release.sh`). It runs the full gate in
   order: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
   `bb plugin types --check .`, `pnpm build`, then `git add -f dist/`.
   It refuses a dirty tree or an existing `vX.Y.Z` tag.
3. The script prints the exact `git commit`, `git tag -a vX.Y.Z`, and
   `git push` commands. Run them yourself; nothing is committed, tagged,
   or pushed for you.
4. Users install or pin the release with
   `bb plugin install git:github.com/adam-tracht/bb-factory@vX.Y.Z`;
   tracking installs pick it up via `bb plugin update bb-factory`.

CI (`.github/workflows/ci.yml`) runs the same gate on pushes and pull
requests to `main` and `factory`. The `bb` binary there comes from the
published `bb-app` npm package; see the workflow for details.
