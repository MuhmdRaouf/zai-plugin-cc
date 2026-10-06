---
description: Submit a zai brief to GLM, or dispatch a task to zai:glm
argument-hint: "<brief.md | task description> [--flash] [--mode edit|exec|readonly] [--wait]"
allowed-tools: Bash(node:*)
---

Run request: $ARGUMENTS

**If the first argument is an existing brief file**, submit it with the Bash tool. By default the job runs detached
and this returns at once with the job id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" run <brief.md> --bg [--flash] [--mode <mode>]
```

If the user passed `--wait`, run `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" run <brief.md> --wait` instead, with
`run_in_background: true`, and review the summary it prints when it completes. The job runs in a detached driver: if
that background command dies, re-attach with `/zai:wait <id>` and never re-run the brief. Report the job id and point
to `/zai:board` and `/zai:review <id>`.

**Otherwise the arguments are a task, not a brief.** Do not run the CLI. Launch an agent with the task (and any
flags) as its prompt: `zai:glm` for code changes, `zai:glm-flash` for read-only sweeps, inventories and command runs
(or when `--flash` was given). The agent drafts the brief, starts the job, replies with one interim line, and later
returns the review summary in a second notification; keep working meanwhile.

Before delegating a task, check it fits: mechanical, and provable by commands. If it is a design or judgment task,
say so in one line and suggest doing it directly, but follow the user's explicit instruction.
