---
description: Stop a running zai job (or all of them)
argument-hint: "<job-id> | --all"
allowed-tools: Bash(node:*)
---

Stop zai job(s): $ARGUMENTS

Run with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" stop <id>
```

or, when the user asked for every job, `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" stop --all`.

A stopped job moves to `awaiting_review` with verdict `stopped`; its partial work is kept. Report which jobs stopped,
then suggest `/zai:review <id>` to decide between returning and discarding them.
