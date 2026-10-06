---
description: Review a zai job (verdict, gates, scope, report, diff)
argument-hint: "<job-id>"
allowed-tools: Bash(node:*)
---

Review zai job: $1

Run with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" review $1 --diff
```

If it exits non-zero, show its one-line error and stop: exit 4 means no job matches the id (suggest `/zai:board`),
exit 2 means the id is missing.

Otherwise the review packet is for you, the reviewer, not a summary to relay. Review it with the zai-loop skill's
checklist: read the diff itself, not only the worker's report; check that tests assert the behaviour; check the change
set against the brief's scope; look for secrets and unrelated edits. For a risky change, re-run one gate yourself in
the job's workspace.

Then tell the user your decision in a few lines: **accept**, **return** (with the exact feedback you would send) or
**discard** (with the reason), and why. Carry it out with `/zai:accept`, `/zai:return` or `/zai:discard` only if the
user asked you to handle the job end to end; otherwise stop after the recommendation.
