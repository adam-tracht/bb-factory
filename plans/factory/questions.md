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
