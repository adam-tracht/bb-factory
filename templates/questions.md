# Factory questions

Append only. The foreman adds entries; the human answers in place with an `answer:` line. A blocking entry with an answer unblocks the task on the next run.

```
## Q<n> <YYYY-MM-DD> <blocking|assumption> <DASHBOARD-ID (one token, use dashes not spaces)>
question: <one paragraph>
context: <where to look>
assumed: <only for assumption entries: what the foreman did>
recommended: <your preferred answer, so the human can reply "yes">
answer:
```

DASHBOARD-ID is exactly one token: the gated entry's id, or a slug for repo-wide topics. When one decision gates several entries, the heading carries the lead entry's id only; give every other gated entry its own `blocked-by: Q<n>` reference in `queue.md` and name them in `context:`. Never write `X and Y` or a range in the heading.

