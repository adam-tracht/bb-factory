# Factory questions

Append only. The foreman adds entries; the human answers in place with an `answer:` line. A blocking entry with an answer unblocks the task on the next run.

```
## Q<n> <YYYY-MM-DD> <blocking|assumption> <DASHBOARD-ID>
question: <one paragraph>
context: <where to look>
assumed: <only for assumption entries: what the foreman did>
recommended: <your preferred answer, so the human can reply "yes">
answer:
```
The kind token is exactly `blocking` or `assumption`; no other word is recognized.
## Q1 2026-09-12 assumption BBF-0012
question: When `approve-queue` runs on a `status: ready` entry that has no `approved:` line, should it attach the line or keep conflicting?
context: planRepositoryAction ready branch in src/actions/repository.ts; the reader emits missing-authorization only for ready entries without approved:, which is the only state where the UI offers Approve.
assumed: approve-queue attaches the approved: line to ready entries lacking one; open question gates still reject, matching text stays already-applied, different text still conflicts.
recommended: Keep this semantics.
answer:

## Q2 2026-09-13 blocking BBF-0029
question: `bb plugin types --check` is a required repo standard check and fails at baseline: pinned @get-bb/plugin-sdk is 0.4.84 while the host runs 0.4.87. BBF-0029 and BBF-0030 are implemented and reviewed but cannot be marked done while it fails, and no in-scope change can fix it. May a dependency repin to 0.4.87 proceed (an `approved:` line, or a dedicated entry like BBF-0022) so the baseline goes green and the completed UI work can land? This is only about the SDK update; the approved UI scope is separate and unchanged.
context: plans/factory/repo.md standard checks table; package.json devDependencies; queue entries BBF-0029/BBF-0030.
recommended: Yes; authorize the repin so the required check passes.
answer: Approved 2026-09-14. Repin @get-bb/plugin-sdk to the host version 0.4.87 and rerun the complete validation suite. This fully resolves Q2.

## Q3 2026-09-15 assumption BBF-0043
question: The preflight step says `git rebase origin/main`, but this repository's main is a synthetic release branch (each main commit is a commit-tree of factory minus plans/ plus dist/, per scripts/release.sh). Rebasing factory onto it would conflict on every plans/-touching commit and merge release artifacts back into working state. Is skipping the rebase and documenting it here the right read?
context: scripts/release.sh:39-45; git rev-list shows factory is only ever "behind" main by release-artifact commits that carry no source changes.
assumed: Fetched origin and skipped the rebase; factory is the sole working branch and main only receives release commits, so there is nothing to rebase onto.
recommended: Yes. If a different sync is wanted, say so and the protocol gets a repo.md override.
answer: No, 2026-09-15 (via chat): main is not a synthetic release branch indefinitely, so permanently skipping the rebase is wrong. Resolution: repo.md now makes the exception conditional - skip the rebase only while origin/main carries nothing but release-artifact commits; the moment any other commit appears, the foreman runs the normal `git rebase origin/main` per the generic protocol, and the existing conflict path (abort, blocking question, blocked state) covers a stray commit on a still-release-shaped tree.

## Q4 2026-09-22 assumption BBF-0049
question: May the Go-live and cutover phase remain unstarted until a human adds an explicit `approved:` line to BBF-0049?
context: plans/native-tasks-migration.md Go-live and cutover section and plans/factory/queue.md BBF-0049.
assumed: Left Go-live and cutover unstarted; BBF-0049 remains without approval for that phase, and no run may perform it.
recommended: Yes; require explicit human approval before Go-live and cutover.
answer:

## Q5 2026-09-22 blocking BBF-0049
question: Can the `factory` branch receive a manual rebase onto `origin/main` before BBF-0049 claim recovery proceeds?
context: Factory preflight required `git rebase origin/main`; it conflicted while replaying `edea29a` (`release: bump version to 0.1.1`) in README.md and package.json, so the rebase was aborted per foreman.md.
recommended: Resolve the factory/main history conflict manually, then rerun the factory bookkeeping session.
answer: Not a blocker, 2026-09-22. The preflight was misapplied. plans/factory/repo.md requires skipping `git rebase origin/main` while main is release-shaped, and it is: the nine most recent commits on origin/main are all `release:` dist artifacts above the known `chore:`/`docs:` v0.1.0 cleanup at the branch base. The run that filed this question rebased anyway and hit the exact conflict the override exists to avoid. No rebase is required and none should be performed. Q3 already settled this rule.

## Q6 2026-09-22 blocking BBF-0049
question: `bb plugin types --check .` is a required repo standard check and fails on `factory`: pinned @get-bb/plugin-sdk is 0.4.87 while the host runs 0.4.104. Branch `factory-tasks` already carries the 0.4.104 pin and passes. Repinning is a dependency change, which repo.md forbids without an `approved:` line. May the repin to 0.4.104 proceed on `factory` so the required check goes green? This is only the SDK pin; no other dependency changes.
context: plans/factory/repo.md standard checks table and the dependency rule; package.json devDependencies on `factory`; Q2 is the 0.4.84 to 0.4.87 precedent, approved 2026-09-14.
recommended: Yes; authorize the repin to 0.4.104 and rerun the full validation suite, matching the Q2 resolution.
answer: 2026-09-22 approved by the human operator in thread thr_2fccwau2pk. Repinned @get-bb/plugin-sdk to 0.4.104 on `factory`; no other dependency changed. The repin surfaced one break: 0.4.104 adds a required `lifecycleOwnerThreadId` to the SDK thread type, so the `makeThread` fixture in tests/interactions-read.test.ts needed the field. Full suite green afterwards: 602 tests, typecheck, lint, build, `bb plugin types --check .`, `git diff --check`. Resolved.

## Q7 2026-09-23 blocking BBF-0049
question: BBF-0049's only remaining work is the Go-live / cutover section of plans/native-tasks-migration.md: dependency declaration for the tasks plugin (install and startup check plus an enable offer, never silent) and per-repo cutover starting with bb-factory itself, ending in deletion of the legacy direct-spawn and markdown-protocol code after one release. Every leg is gated: the dependency declaration is a dependency change, and cutover changes dispatch behavior. May the Go-live and cutover phase proceed, and under what `approved:` scope? This is the actionable form of the gate Q4 recorded as an assumption.
context: plans/native-tasks-migration.md "Go-live / cutover (sequence last)"; queue entry BBF-0049; implementation is complete and reviewed on branch `factory-tasks` in worktree /Users/adamtracht/Desktop/Code/bb-factory-tasks at 47c4b9f.
recommended: Yes. Approve with a scope covering all three legs, for example `approved: tasks dependency declaration, per-repo cutover starting with bb-factory, legacy direct-spawn and markdown-protocol deletion after one release`; narrow the line if any leg should stay human-run.
answer:

## Q8 2026-09-23 blocking BBF-0007
question: BBF-0007's acceptance criteria are all protected operations. The release side is already done: the repo is public at adam-tracht/bb-factory and tags v0.1.0 through v0.1.9 are pushed. What remains is authoring entries/bb-factory.json (v2 entry with icon, screenshots, and overview) in a fork of get-bb/marketplace and submitting it via PR or the registry intake form per the registry README at submit time. May a run create the fork entry and open the submission, and under what `approved:` scope?
context: queue entry BBF-0007; PLAN.md Phase 6 deliverable 7; the submit-a-plugin skill covers the mechanics.
recommended: Yes. Approve with a scope like `approved: marketplace fork entry, submission PR`; the registry README decides PR versus intake form at submit time.
answer:
