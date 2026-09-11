# Releasing bb-factory

bb-factory is distributed as a git source. bb resolves release tags named
`vX.Y.Z` repository-wide, so a release is a pushed tag on a commit that
carries the built plugin.

## Branch model

`factory` carries development, including this repository's own
`plans/factory/` protocol state (queue, run records, questions). `main` is
release-only: each release commit is the `factory` tree minus `plans/`
plus the built `dist/` bundles, parented on the previous `main` tip.
Nothing merges from `factory` into `main`, so internal protocol files
never ship and `main` always fast-forwards. Do not push `factory`
directly to `main`.

## dist strategy

`dist/` stays gitignored during development. For git-source installs bb runs
`npm install` and rebuilds the bundles itself (a committed `dist/` is
replaced), while npm-source installs require a metadata-validated prebuilt
bundle. Shipping `dist/` in the release commit keeps the tag install-ready
for both source kinds and matches what CI built. The release script
adds it to the release tree in a scratch index; it never lands in the
worktree or on `factory`.

## Steps

1. On `factory` with a clean tree, bump `version` in package.json and
   commit that normally.
2. Run `pnpm release` (`scripts/release.sh`). It runs the full gate in
   order: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
   `bb plugin types --check .`, `pnpm build`, then assembles the release
   commit on local `main` (tree minus `plans/`, plus `dist/`) and tags it
   `vX.Y.Z`. It refuses a dirty tree or an existing tag.
3. The script prints the exact `git push origin main` and
   `git push origin vX.Y.Z` commands. Run them yourself; nothing is
   pushed for you.
4. Users install or pin the release with
   `bb plugin install git:github.com/adam-tracht/bb-factory@vX.Y.Z`;
   tracking installs pick it up via `bb plugin update bb-factory`.

CI (`.github/workflows/ci.yml`) runs the same gate on pushes and pull
requests to `main` and `factory`. The `bb` binary there comes from the
published `bb-app` npm package; see the workflow for details.
