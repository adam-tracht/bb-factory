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
