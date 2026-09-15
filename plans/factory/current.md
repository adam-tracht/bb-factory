# Current factory run

Interactive session 2026-09-14 implemented BBF-0039, the approved repository
display-name feature. BBF-0039 is complete based on compliance corrections and
automated checks. Code-quality review and live visual validation are explicitly
deferred by the user. Optional displayName metadata stays outside
RepositoryConfiguration; repositoryKey remains the operational identity.
Add repository, Settings, shell, landing, aggregate, empty-state, and
confirmation surfaces use the resolved label, while routes, ids, storage,
actions, RPC inputs, and technical details retain the raw key. BBF-0039
remains intentionally uncommitted and unpushed in the working tree per the
direct human request.

The same session completed BBF-0040, user-reported overview fixes: Needs
attention rows reveal detail only on expand instead of duplicating it,
desktop Work queue repository rows carry status chips and Open work inline
in the header, and repository subgroup headings render at normal weight.
BBF-0040 is committed on `factory` and pushed to origin/factory.

Automated validation passed: 473 tests, typecheck, lint, build, SDK declarations,
and whitespace checks. Code-quality review and live visual validation are
explicitly deferred by the user.

state: success
