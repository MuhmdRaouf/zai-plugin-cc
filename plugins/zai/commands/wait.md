---
description: Follow a running zai job until it lands in review, then show its summary
argument-hint: "<job-id>"
allowed-tools: Bash(node:*)
---

Wait for zai job: $1

Run with the Bash tool and `run_in_background: true` (it returns when the job lands; keep working meanwhile):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" wait $1
```

When it completes, show its output as it is. Exit 0 or 3 printed the summary (3: the verdict is not `pass`); suggest
`/zai:review <id>`. Exit 4 means no job matches the id: suggest `/zai:board`. Exit 6 means the job's driver died: pass
on its advice (`/zai:stop` or `/zai:discard`). Waiting never changes the job: stopping it is `/zai:stop`.
