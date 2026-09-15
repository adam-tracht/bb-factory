# Current factory run

Interactive session 2026-09-14 implemented BBF-0039, the approved repository
display-name feature. BBF-0039 is complete based on compliance corrections and
automated checks; code-quality review and live visual validation are
explicitly deferred by the user. Optional displayName metadata stays outside
RepositoryConfiguration; repositoryKey remains the operational identity.
Add repository, Settings, shell, landing, aggregate, empty-state, and
confirmation surfaces use the resolved label, while routes, ids, storage,
actions, RPC inputs, and technical details retain the raw key. BBF-0039 was
committed as 434765f on `factory` and pushed to origin/factory.

The same session completed BBF-0040 (overview attention duplication fix,
inline desktop work-queue chips, normal-weight repository subgroup headings)
and follow-ups BBF-0041 (attention rows keep dot, title, and action on one
line when collapsed; expanded detail indents under the title) and BBF-0042
(severity dot, caret, and action anchor to the title's first line at every
width instead of the dot centering on the expanded row block). All are
committed on `factory` and pushed to origin/factory.

Validation for BBF-0040, BBF-0041, and BBF-0042: 473 tests, typecheck, and
lint pass.

state: success
