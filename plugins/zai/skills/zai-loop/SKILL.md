---
name: zai-loop
description: This skill should be used when deciding whether to hand work to GLM through the zai plugin, when writing a zai brief, dispatching the zai:glm or zai:glm-flash agents, reviewing a zai job (review packet, verdict, diff), or accepting, returning or discarding one. Also applies when the user says "delegate this to GLM", "use zai", "offload the bulk work", "run these in parallel on GLM", or a session-start line reports zai jobs awaiting review.
---

# The zai loop

GLM (Z.ai) does bulk mechanical work; the plugin verifies it deterministically (runs the brief's gates itself, checks
the change set against scope, validates the report); Claude decides. Verification is mechanical, review is judgment:
the plugin never accepts anything, and a worker's "done" is never evidence.

```
brief → job runs (GLM) → plugin verifies → awaiting_review → Claude: accept | return(feedback) | discard
```

Every job lands in `awaiting_review` with a verdict, including failures, because only Claude decides.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" <command>`. Slash commands `/zai:<command>` wrap the same CLI.

## 1. Decide whether to delegate

Delegate when the work is **mechanical and provable by commands**:

- many similar edits: renames, API migrations, codemods, repetitive refactors
- implementation that follows a pattern already in the repo, or a spec precise enough to test
- adding tests for existing behaviour; fixing failures whose cause is known
- sweeps and inventories: find every usage, check every module against a rule, run a command per package and tabulate

Keep it when the work needs **judgment**: design and architecture, unclear requirements, debugging an unknown root
cause, security-sensitive code (auth, crypto, permissions), anything needing secrets or production access, and small
changes faster to make directly than to brief and review.

Test for edit work: if no gate can fail before the change and pass after it, do not delegate it yet. Design first,
write or name the test, then delegate the bulk.

## 2. Choose the route

| Situation | Route |
|---|---|
| Task in words, code change | Agent `zai:glm` (GLM-5.3, edit mode, own git worktree) |
| Task in words, sweep or inventory | Agent `zai:glm-flash` (GLM-5.3-flash, exec mode, repository untouched) |
| Brief already written | `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" run <brief.md> --bg` |
| Many briefs written | `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" batch '<dir or glob>'` |

Agent prompts must be self-contained: the dispatcher sees none of this conversation. Name the files, the pattern to
follow, the expected behaviour, and the commands that prove it. A dispatcher replies first with one interim line
(`zai job <id> started: ...`); keep working. It returns the review summary later, in a second notification. Launch
several dispatchers in one message to run tasks in parallel.

## 3. Write briefs GLM succeeds at

A brief is Markdown with YAML front matter; the body is the whole task. GLM sees only the brief and a fixed contract
footer, so:

- **Self-contained body**: goal, context (exact paths, a `file:line` example of the pattern), numbered steps, and
  "done when" criteria.
- **Exact scope**: the narrowest globs that cover the change, tests included; `forbid` lockfiles, CI, secrets and
  generated files. Out-of-scope edits fail verification (`scope_violation`).
- **Gates that prove the behaviour**: the repository's own targeted tests first, then typecheck or lint. A gate that
  passes without the change proves nothing.
- **Report**: `change` (edit), `sweep` (exec), `notes` (readonly); for sweeps, define what an item is and when it is
  `ok`, `fail` or `gap`.

Field reference, defaults, examples and anti-patterns: **`references/brief-guide.md`**. Lint before submitting:
`node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" brief lint <path>`.

## 4. Review

Read the packet with the diff: `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" review <id> --diff`. Then:

- Read the diff itself, not just the worker's report or the gate results.
- Check that tests assert the behaviour (not snapshots of whatever came out, not weakened or skipped assertions).
- For a risky change, re-run one gate yourself in the job's workspace.
- Reject scope creep: unrelated edits, reformatting, new dependencies, config changes the brief did not ask for.
- Look for secrets, credentials and debug leftovers in the diff and in artifacts.

Verdict meanings and the full checklist: **`references/review-checklist.md`**.

## 5. Decide

- **Accept** only after reading the diff:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" accept <id>` commits on the job branch and cherry-picks onto the current
  branch (`--no-commit` applies to the working tree instead). Exit 5 means a conflict: nothing was applied; return the
  job asking for a rebase.
- **Return** when the work is fixable: the worker resumes its own session with the feedback and is verified again:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" return <id> '<feedback>'`.
- **Discard** when the approach or the brief is wrong, or the work is no longer wanted (worktree is deleted):
  `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" discard <id> --reason '<why>'`. Resubmit a corrected brief if needed.

Feedback for `return`: one numbered item per problem with `file:line`, what is wrong, what correct looks like, and the
gate or done-criterion it violates; say what to keep and what to revert. No praise, no restating the brief, no
questions. If the same problem survives two returns, fix the brief or do the work directly instead of returning again.

## 6. Batch etiquette

One Z.ai account limit is shared by every job and anything else using the key. The plugin caps concurrent workers and
backs off on 429s automatically, so:

- Submit a batch once; do not resubmit queued jobs or start duplicates to "speed up". A job outlives whatever
  waits on it: if a waiter or dispatcher dies, `wait <id>` re-attaches; never `run` the same brief again.
- Prefer one `batch` (or one message of parallel dispatchers) over many separate runs.
- Prefer `glm-flash` for sweeps: it is cheaper and faster.
- Watch `node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" usage` when running many jobs; frequent rate-limit retries mean fewer
  jobs at once.
- Review as results arrive; do not let `awaiting_review` pile up.

## Commands

| Command | Use |
|---|---|
| `board [--all]` | jobs and states (`/zai:board`) |
| `show <id>` | one job's attempts and progress |
| `wait <id>` | follow a running job to its summary; Ctrl-C only detaches (`/zai:wait`) |
| `review <id> --diff` | review packet with diff |
| `accept`, `return`, `discard` | the decision |
| `stop <id> \| --all` | stop running jobs (they land in review as `stopped`) |
| `usage`, `setup [--ping]` | token use; readiness check |
| `brief new <title> --mode <m>`, `brief lint <path>` | brief template; validation |
