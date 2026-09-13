# Run record: multi-id question headings break the protocol read

- Date: 2026-09-12
- Thread: this interactive session (thr_m55bq4jmcb, acp-devin foreman)
- Tasks attempted: BBF-0024 (multi-id question headings fail the whole protocol read)

## Outcome

- BBF-0024: done. Reported live on diggs-data-platform (Work tab error on
  `Q14 2026-09-10 blocking DATA-0064 and DATA-0009.01`) and monorepo
  (`Q15 2026-09-12 blocking MON-0080.06 and MON-0080.08 through MON-0080.13`,
  with the Overview degraded banner). Both headings put a natural-language
  id list in the single-token dashboard-id slot; one malformed heading makes
  `parseQuestions` throw malformed-protocol, which fails the whole snapshot.
- Root cause: a blocking question that genuinely gates several entries has
  no legal way to name them all in the heading. The foreman invented `X and
  Y` phrasing twice, once per repository. The diggs file already annotated
  the id as "one token" but did not say what to do for a multi-entry gate.
- Data fixes: diggs-data-platform-factory `8da79bc` rewrites the heading to
  `blocking DATA-0064`, the entry Q14 actually gates through dashboardId;
  DATA-0009.01 stays gated by its own `blocked-by: Q14` field, so no gate
  was lost. monorepo-factory `1b21e2e` rewrites Q15 to `blocking MON-0080`,
  matching Q14's parent-row convention in the same file; every referenced
  entry is `status: ready` and the question is answered, so the heading id
  is now descriptive only. Both files also gained the multi-entry rule in
  their format comment.
- Prevention: `templates/questions.md` and `templates/foreman.md` state the
  one-token rule and the lead-id-plus-`blocked-by` pattern where foremen
  read it; the malformed-heading error message now names the expected shape
  so the next failure self-describes the fix; `MANIFEST.json` rehashed.
  Wire contract v1.2 unchanged: `dashboardId` remains a single string.

## Validation

- `pnpm test`: 27 files, 320 passing (added a multi-id heading case)
- `pnpm typecheck`, `pnpm lint`: clean
- `tests/read-integration.test.ts` reads both live checkouts and confirms
  the repaired questions.md files parse

state: success
