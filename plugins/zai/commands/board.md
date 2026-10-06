---
description: Show zai jobs for this repository (--all for every repository)
argument-hint: "[--all]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" board $ARGUMENTS`

Show the board above to the user as it is, without reformatting. Then, in one line, name the jobs in
`awaiting_review` and suggest `/zai:review <id>` for each; flag any job shown as stale (its driver died). Add nothing
else.
