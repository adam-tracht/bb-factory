# Current factory run

Run 2026-09-15T04:39Z (thread thr_fcb53czy7e) completed BBF-0043 (provider,
model, and thinking picker on manual Run now), BBF-0044 (per-provider
default model and thinking in Settings), and BBF-0045 (user-configured
alternate rotation of up to 5 providers). All three committed on `factory`
and pushed to origin/factory (eb7672a, 049fd31, a57367d). Validation: 524
tests, typecheck, lint, build, SDK freshness, and whitespace pass.

One assumption question filed: Q3 documents skipping the preflight rebase
onto origin/main, which is a synthetic release branch in this repository.

A later interactive session completed BBF-0046 (attention-row severity dot
baseline drift: the dot's span wrapper is now display:flex so mt-1.5 pins a
true top offset instead of the dot floating inside the wrapper's line box).
Committed on `factory` and pushed to origin/factory. Validation: 524 tests,
typecheck, and lint pass.

state: success
