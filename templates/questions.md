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

