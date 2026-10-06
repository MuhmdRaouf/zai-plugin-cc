---
description: Create a zai brief template or lint an existing brief
argument-hint: "new <title> [--mode edit|exec|readonly] | lint <path>"
allowed-tools: Bash(node:*)
---

Brief request: $ARGUMENTS

Run the matching subcommand with the Bash tool, quoting the title:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" brief new '<title>' --mode <edit|exec|readonly>
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" brief lint <path>
```

- `new` prints the path of a fresh template. Read it, then help fill it in following the zai-loop skill's brief guide:
  self-contained body, exact `scope`, `gates` that prove the behaviour, the report kind for the mode. Lint it when done.
- `lint` prints every problem at once (exit 2 when invalid). Fix them all, then lint again until clean.

Submit a finished brief with `/zai:run <path>`.
