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
answer:
