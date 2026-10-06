---
description: Accept a reviewed zai job and land its change
argument-hint: "<job-id> [--no-commit] [--force] [--no-verify]"
allowed-tools: Bash(node:*)
---

Accept zai job: $ARGUMENTS

Accept only work you have reviewed. If you have not read this job's diff in this session, first run
`node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" review <id> --diff`, review it with the zai-loop skill's checklist, and stop
with a `return` or `discard` recommendation if it does not pass. Never accept on the worker's report alone.

Then run with the Bash tool, passing the user's flags through:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" accept <id> [--no-commit] [--force] [--no-verify]
```

- Default: commits the change on the job branch and cherry-picks it onto the current branch. `--no-commit` applies
  it to the working tree instead. The repository's commit hooks run.
- Exit 3 means the verdict is not `pass`: accept it anyway with `--force` only if the user asked for it.
- Exit 1 after a `git commit:` line means a commit hook failed: the job still awaits review. Report the hook's output;
  add `--no-verify` only if the user asked to skip the hooks.
- Exit 5 means a conflict: nothing was applied. Report the conflicting paths and suggest `/zai:return <id>` asking
  the worker to rebase onto the current branch.
- On success, report the commit (or the applied files) in one or two lines.
