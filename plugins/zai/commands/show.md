---
description: Show one zai job's state, attempts and progress
argument-hint: "<job-id>"
allowed-tools: Bash(node:*)
---

Show zai job: $1

Run with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" show $1
```

If it exits non-zero, show its one-line error: exit 4 means no job matches the id, so suggest `/zai:board`.

Otherwise show the output to the user as it is. If the job is `awaiting_review`, suggest `/zai:review <id>` in one
line.
