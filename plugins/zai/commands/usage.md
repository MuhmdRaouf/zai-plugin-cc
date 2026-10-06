---
description: Show GLM token usage and cost per model tier
argument-hint: "[--all]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" usage $ARGUMENTS`

Show the usage table above to the user as it is. If it reports rate-limit retries (429), add one line noting that the
shared Z.ai limit is being hit and fewer concurrent jobs would help. Add nothing else.
