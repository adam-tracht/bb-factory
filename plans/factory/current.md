# Current factory run

Run 2026-09-22T16:17Z (thread thr_2fccwau2pk) recovered BBF-0049 from a stale
claim and recorded the reviewed state of the native Tasks core rebuild. The
claim held by dead thread thr_wswppd4ja4 was released to `status: ready`.

Implementation through Phase 3 lives on branch `factory-tasks` in commits
2e5e7cc, ce2bce7, 8253791, and 47c4b9f: self-attributing settlement markers, a
fresh card re-read before the mutation, settlement markers excluded from the
approval content revision, run-scoped settlement acceptance, and one shared
tolerant marker grammar. Three independent reviews returned PASS with no
blocking findings. At 47c4b9f: 660 tests across 32 files, typecheck, lint,
build, SDK freshness, and whitespace all pass.

Remaining work on BBF-0049 is the Go-live and cutover section only, which needs
an explicit `approved:` line from the human.

Q5 was filed by the preceding run and is closed as not a blocker: repo.md
requires skipping the rebase onto origin/main while main is release-shaped, and
it is. Q4 stays open as an assumption awaiting human confirmation. Q6 is filed
blocking: `bb plugin types --check .` fails on `factory` with the SDK pinned at
0.4.87 against host 0.4.104, and repinning is a dependency change that needs an
`approved:` line.

state: success
