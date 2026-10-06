---
description: Check that zai is ready (claude binary, Z.ai key, state dir)
argument-hint: "[--ping]"
allowed-tools: Bash(node:*)
---

Run with the Bash tool, passing the user's arguments through (`$ARGUMENTS`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" setup $ARGUMENTS
```

Exit 6 means not ready; the report still names every check. Show the report to the user. If something is not ready,
give the fix for each failing line:

- Z.ai key missing: set `ZAI_API_KEY` in the environment Claude Code starts from, or put `ZAI_API_KEY=<key>` in
  `~/.config/zai-plugin-cc/env` and run `chmod 600` on it. Never ask the user to paste the key into the chat, and never
  read or print that file.
- `claude` binary missing or too old: install or update Claude Code so `claude` is on `PATH`.
- ping failed: the line says why (an API error such as 401 means the key is wrong or revoked).

`--ping` also sends a minimal request to Z.ai to prove the key works.
