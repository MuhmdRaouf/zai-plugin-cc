---
description: Discard a zai job and remove its workspace
argument-hint: "<job-id> [--reason <text>]"
allowed-tools: Bash(node:*)
---

Discard zai job: $ARGUMENTS

Discarding deletes the job's worktree and branch; it cannot be undone. Prefer `/zai:return` when the work is fixable
with feedback. Discard when the approach is wrong, the brief was wrong (write a better brief and resubmit), or the work
is no longer wanted.

Run with the Bash tool, recording why (single-quoted; write each `'` inside it as `'\''`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" discard <id> --reason '<why>'
```

Report the result in one line.
