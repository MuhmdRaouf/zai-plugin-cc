---
description: Submit many zai briefs at once (directory, glob or manifest)
argument-hint: "<dir | glob | manifest.txt>"
allowed-tools: Bash(node:*)
---

Batch request: $ARGUMENTS

Submit every brief with the Bash tool; quote a glob so the CLI expands it, not the shell:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" batch '<dir|glob|manifest.txt>'
```

Each valid brief becomes a detached job; invalid ones are listed with their errors and the rest still go. Report the
submitted ids and every rejected path with its error, then point to `/zai:board`. The jobs share one Z.ai rate limit;
the plugin paces them, so do not resubmit jobs that are queued.

`batch` takes briefs that are already written. For several tasks that have no brief yet, launch one `zai:glm` (code
changes) or `zai:glm-flash` (sweeps) agent per task in a single message instead; each drafts its own brief and returns
its review summary when done.
