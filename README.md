# zai

[![ci](https://github.com/MuhmdRaouf/zai-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/MuhmdRaouf/zai-plugin-cc/actions/workflows/ci.yml)
[![License: GPL v3+](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) plugin that hands bulk mechanical work to **GLM** models on
[Z.ai](https://z.ai), checks it, and leaves the decision to Claude.

- **GLM does the bulk work.** That means many similar edits, pattern-following implementation, test backfills and
  sweeps over a codebase. Each job runs headless Claude Code against Z.ai's Anthropic-compatible API, in its own git
  worktree.
- **The plugin verifies it deterministically.** It runs the brief's gates itself, checks every changed path against
  the brief's scope, and validates the worker's structured report. A worker saying "done" is never taken as evidence.
- **Claude reviews and decides.** For each job Claude reads the diff and either accepts it (one commit), returns it
  with feedback (the same GLM session resumes), or discards it. The plugin never accepts anything on its own.

```
brief ──▶ GLM worker ──▶ plugin verifies ──▶ awaiting review ──▶ Claude: accept │ return(feedback) │ discard
              ▲            gates · scope ·                                              │
              │            report contract                                              │
              └─────────── auto-fix (same session) ◀── failed verdict    return ────────┘
```

This is not a general-purpose "second model" bridge. It is built for one loop: GLM does cheap, parallel, mechanical
work, and Claude orchestrates, verifies and reviews it.

> Not affiliated with Z.ai or Anthropic. You need your own Z.ai API key, and GLM usage is billed to it.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Setup](#setup)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Writing briefs](#writing-briefs)
- [Reviewing and deciding](#reviewing-and-deciding)
- [Commands](#commands)
- [Running many jobs](#running-many-jobs)
- [Security and privacy](#security-and-privacy)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- Claude Code, with the `claude` CLI on `PATH`. The plugin runs workers through `claude -p`.
- Node.js 22.3 or newer. The plugin ships as one bundled script (`plugins/zai/dist/zai.js`) with no runtime install step.
- git, for edit jobs, which run in git worktrees.
- A Z.ai API key with access to `glm-5.3` and `glm-5.3-flash`.

## Install

From GitHub, at user scope (available in every project):

```
/plugin marketplace add MuhmdRaouf/zai-plugin-cc
/plugin install zai@muhmdraouf
```

User scope is the default. From a terminal the same is
`claude plugin marketplace add MuhmdRaouf/zai-plugin-cc && claude plugin install zai@muhmdraouf --scope user`
(`--scope project` or `local` enables it for one repository only).

From a local clone (for development):

```
/plugin marketplace add /path/to/zai-plugin-cc
/plugin install zai@muhmdraouf
```

## Setup

Give the plugin your Z.ai key in one of two ways:

- export `ZAI_API_KEY` in the environment Claude Code starts from, or
- put it in a private env file:

  ```sh
  mkdir -p ~/.config/zai-plugin-cc
  printf 'ZAI_API_KEY=%s\n' '<your key>' > ~/.config/zai-plugin-cc/env
  chmod 600 ~/.config/zai-plugin-cc/env
  ```

  The plugin refuses a key file that other users can read.

Then check that everything is in place:

```
/zai:setup --ping
```

`setup` reports the `claude` binary and version, whether a key was found (never its value), the state directory and
the concurrency cap. `--ping` also sends one tiny request to `glm-5.3-flash` and reports its cost.

## Quick start

Ask Claude in plain words. The `zai-loop` skill teaches it when and how to delegate:

> Use zai to migrate every `getUserById` call in `src/` to `findUser`, and keep the tests green.

Or dispatch an agent explicitly:

- `zai:glm` (GLM-5.3) for code changes, which run in their own worktree.
- `zai:glm-flash` (GLM-5.3-flash) for sweeps and inventories, which leave the repository untouched.

The dispatcher writes a brief, starts the job and replies at once with
`zai job <id> started: …`, so Claude keeps working. When the job lands, the dispatcher returns the review summary.
Claude then reviews and decides:

```
/zai:review <id>                  # verdict, gates, report and the diff
/zai:accept <id>                  # one commit on your current branch
/zai:return <id> <feedback>       # the same GLM session fixes it, then it is verified again
/zai:discard <id> --reason <why>
```

When jobs are waiting for review, a session-start hook prints one line about them.

## How it works

### Roles

| Role | Who | Does |
|---|---|---|
| Orchestrator | Claude (your session) | decides what to delegate, writes or approves briefs |
| Dispatcher | `zai:glm` / `zai:glm-flash` subagents (Sonnet) | turns a request into a brief, starts the job, relays the result |
| Worker | GLM via headless Claude Code on Z.ai | does the work inside the job's workspace |
| Verifier | the plugin (deterministic code) | runs the gates, checks scope and the report, derives a verdict |
| Reviewer | Claude | accepts, returns with feedback, or discards |

### Job lifecycle

```
queued ─▶ running ─▶ verifying ─▶ awaiting_review ─▶ accepted
   ▲                    │                │
   │                    └─ auto-fix ─────┤ (same GLM session, while the fix budget lasts)
   └──────────── return(feedback) ◀──────┤
                                         └─▶ discarded
```

Every attempt ends in a **verdict**. The first matching row wins:

| Verdict | Meaning | What happens next |
|---|---|---|
| `stopped` | you stopped the job | review |
| `timeout` | the attempt hit its time limit | infra retry while budget lasts, then review |
| `worker_error` | Z.ai API error or the worker crashed | infra retry while budget lasts, then review |
| `scope_violation` | a changed path is outside `scope`, inside `forbid`, or an exec/readonly job changed the repository | auto-fix while budget lasts, then review |
| `report_invalid` | the structured report is missing or breaks its schema | auto-fix while budget lasts, then review |
| `gate_fail` | a gate exited non-zero or timed out | auto-fix while budget lasts, then review |
| `pass` | gates passed, in scope, valid report | review |

Every job ends in `awaiting_review`, including failed ones, because only Claude decides. Auto-fix and return both
resume the worker's own GLM session, so it keeps its context. A reviewer's return gives the job a fresh fix budget.

### Modes

| Mode | Workspace | Worker may | Verification adds |
|---|---|---|---|
| `edit` | `git worktree` on branch `zai/<id>` from `base` | change files inside `scope` | the change set against `scope`/`forbid` |
| `exec` | the repository itself | run commands; write only to `$ZAI_ARTIFACTS` | the repository must be byte-for-byte unchanged |
| `readonly` | the repository, plan mode | read only | the repository must be unchanged |

Workers never commit. `accept` makes the one commit, on the job branch, with the title, the report summary and a
`Worked-by: glm-5.3 via zai` trailer, then cherry-picks it onto your current branch. Your repository's commit hooks run
(`--no-verify` skips them). `accept --no-commit` applies the change to the working tree instead. A cherry-pick conflict
applies nothing and exits 5; return the job and ask it to rebase.

### No daemon

Each job is driven by its own process, double-forked so it is an orphan: nothing that kills its caller's process tree,
such as Claude Code cleaning up a background shell, can reach it. `run --wait` starts that driver and only follows
the job; killing the follower never stops the job, and `zai wait <id>` re-attaches. A per-job lock makes sure only one driver ever owns a
job. All state is plain files: jobs, attempts, stream logs, artifacts and worktrees live under the state directory.

## Writing briefs

A brief is Markdown with YAML front matter. The body is the whole task, because GLM sees only the brief plus a fixed
contract footer. The footer covers the workspace rules, scope, the gates the plugin will run, and how to finish with
the report.

```markdown
---
title: "slugify: real slugs"
mode: edit
model: glm
scope: ["src/strings.js", "test/strings.test.js"]
forbid: ["package.json"]
gates: [npm test]
timeout: 15m
retries: { fix: 1, infra: 1 }
report: change
---
`slugify` in `src/strings.js` only lowercases. Make it produce URL slugs:
1. lowercase; 2. trim; 3. strip diacritics; 4. replace each run of characters other than `a-z0-9` with one `-`;
5. strip leading and trailing `-`.
Add node:test cases for `"  Hello, World!  "` -> `"hello-world"` and `"Crème Brûlée"` -> `"creme-brulee"`.
Done when `npm test` passes.
```

| Field | Default | Meaning |
|---|---|---|
| `title` | required | short name shown on the board and in commit messages |
| `mode` | `edit` | `edit`, `exec` or `readonly` (see [Modes](#modes)) |
| `model` | `glm` for edit, else `flash` | `glm` = glm-5.3, `flash` = glm-5.3-flash |
| `effort` | unset | `low` / `medium` / `high`, passed to `claude --effort` |
| `cwd` | current git root | repository the job works on |
| `base` | `HEAD` | ref the worktree starts from |
| `scope` | `["**"]` for edit, `[]` otherwise | globs the change set may touch (picomatch, dotfiles included) |
| `forbid` | `[]` | globs that must stay untouched even inside scope |
| `gates` | `[]` | commands the plugin runs after the worker: a string, or `{ run, timeout }` (default 10m) |
| `timeout` | `2h` | per attempt: `90s`, `15m`, `1h30m`, or milliseconds |
| `retries` | `{ fix: 1, infra: 2 }` | auto-fix rounds after a failed verdict; re-runs after infrastructure errors |
| `report` | `change` / `sweep` / `notes` by mode | a built-in report schema, or a path to a JSON Schema file (draft-07) |
| `addDirs` | `[]` | extra readable paths, passed as `--add-dir` |
| `env` | `[]` | names of your environment variables to pass to the worker and gates (values are never stored) |
| `budgetUsd` | unset | spending cap per attempt, passed as `--max-budget-usd` |
| `tags` | `[]` | free labels for batches and board filters |

Built-in reports:

- `change`: `{ summary, files: [{path, why}], root_cause?, tests_added[], open_items[] }`
- `sweep`: `{ summary, items: [{id, status: ok|fail|gap, detail}], open_items[] }`
- `notes`: `{ summary, findings: [{title, detail, refs[]}], open_items[] }`

What makes a brief work:

- **Gates prove the behaviour.** A gate that passes without the change proves nothing. Write or name the test first,
  then delegate the bulk.
- **Narrow scope.** Use the narrowest globs that cover the change, tests included. Forbid lockfiles, CI config and
  generated files.
- **Self-contained body.** Give exact paths, a `file:line` example of the pattern to follow, numbered steps, and
  "done when" criteria.
- **Keep the judgment calls.** Design, unclear requirements, unknown root causes, security-sensitive code and anything
  that needs secrets stay with Claude.

`zai brief new <title> --mode edit` prints the path of a fully commented template; `zai brief lint <path>` checks a
brief exactly the way `run` will. The plugin ships a longer guide in
`plugins/zai/skills/zai-loop/references/brief-guide.md`.

## Reviewing and deciding

`/zai:review <id>` shows:

- the verdict;
- every attempt;
- each gate's exit code and output tail;
- the scope check;
- the report;
- with `--diff`, the full diff.

The review checklist the skill follows:

1. Read the diff itself, not just the report or the gate results.
2. Check that the tests assert the behaviour. Watch for snapshots of whatever came out, and for weakened or skipped
   assertions.
3. Re-run a gate yourself for risky changes.
4. Reject scope creep: unrelated edits, reformatting, new dependencies.
5. Look for secrets and debug leftovers in the diff and in the artifacts.

Return feedback as one numbered item per problem: `file:line`, what is wrong, and what correct looks like. If the same
problem survives two returns, fix the brief or do the work directly.

## Commands

The slash commands wrap the CLI. You can also call the CLI directly:
`node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" <command>`.

| Command | Does |
|---|---|
| `run <brief.md\|-> [--flash] [--mode m] [--wait\|--bg]` | submit a brief and start it (`-` reads stdin) |
| `wait <id>` | follow a job until it lands in review (re-attach after a waiter was killed) |
| `batch <dir\|glob\|manifest.txt>` | submit many briefs at once |
| `board [--all]` | jobs and their states |
| `show <id> [--follow]` | one job's attempts and live progress |
| `review <id> [--diff]` | the review packet |
| `accept <id> [--no-commit] [--no-verify] [--force]` | land the change (`--force` accepts a non-pass verdict) |
| `return <id> <feedback…>` | send it back to the same worker session |
| `discard <id> [--reason <text>]` | drop it and delete its worktree |
| `stop <id\|--all>` | stop running jobs; they land in review as `stopped` |
| `usage [--all]` | tokens, cost, first-try rate, 429s per model |
| `setup [--ping]` | readiness check |
| `brief new <title> [--mode m]`, `brief lint <path>` | brief template and validation |

All commands except `brief` take `--json` for machine-readable output.

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | unexpected error |
| 2 | usage error |
| 3 | the job did not pass (`run --wait`, `wait`) |
| 4 | job not found |
| 5 | conflict (a cherry-pick conflict, or a job busy with another driver) |
| 6 | not ready: `setup` failed, or the job has no live driver and needs `stop` or `discard` |
| 130 | a follower was interrupted; the job keeps running |

## Running many jobs

All jobs, and anything else using your key, share one Z.ai rate limit. The plugin caps how many workers run at once
with a file-based semaphore and adapts the cap from live 429 responses: it halves the cap on a rate-limit burst, with
a cooldown, and adds one back after a quiet period. Bounds are `[1, ZAI_MAX_CONCURRENCY]`.

- Submit a batch once: `zai batch 'briefs/*.md'`, or several dispatchers in one message. Don't resubmit queued jobs.
- Use `glm-flash` for sweeps; it is cheaper and faster.
- Watch `zai usage`. Frequent 429 retries mean fewer jobs at once would finish sooner.
- Review jobs as they land; don't let `awaiting_review` pile up.

## Security and privacy

- **Your key stays out of everything else.** It is read from `ZAI_API_KEY` or the 0600 env file. It is never printed
  or logged, never written to job state, and set only in the worker process's environment.
- **Workers get an allowlisted environment.** That is `PATH`, `HOME`, locale and terminal variables, plus the
  variable names a brief lists in `env`. Nothing else from your session leaks in, including your Anthropic credentials,
  `CLAUDE_*` and plugin variables. Tests enforce this.
- **Your Claude Code login is untouched.** Workers run with their own `CLAUDE_CONFIG_DIR` under the state directory,
  so their settings, sessions and memory never mix with yours.
- **Edit jobs run in separate worktrees, and workers never commit.** Exec and readonly jobs must leave the repository
  unchanged, or they fail verification.
- **Workers can run commands.** They do so inside their workspace with `bypassPermissions` (edit and exec modes),
  like any autonomous coding agent. Only delegate repositories and tasks you would let an agent run unattended.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ZAI_API_KEY` | from `~/.config/zai-plugin-cc/env` | Z.ai API key |
| `ZAI_MAX_CONCURRENCY` | `8` | upper bound for concurrent workers |
| `ZAI_STATE_DIR` | see below | where jobs, worktrees and logs live |
| `ZAI_CLAUDE_BIN` | `claude` | the Claude Code binary workers run |

The state directory is `ZAI_STATE_DIR` when set; otherwise the plugin's own Claude Code data directory, then
`$XDG_STATE_HOME/zai`, then `~/.local/state/zai`. It is created with mode 0700.

## Troubleshooting

- **`setup` says no key.** Export `ZAI_API_KEY` in the shell Claude Code starts from, or create the env file with
  mode 0600.
- **Lots of 429s, or jobs stay queued.** The shared rate limit is saturated. Lower `ZAI_MAX_CONCURRENCY` or submit
  fewer jobs at once; the limiter adapts on its own.
- **A job shows `running (stale)`.** Its driver process is gone, after a reboot or a killed process. Run
  `/zai:stop <id>` to move it to review, or `/zai:discard <id>`.
- **`accept` exits 5.** The change conflicts with your current branch, so nothing was applied. Return the job and ask
  it to rebase onto your branch.
- **A commit hook rejects `accept`.** The job stays in review with the hook's output. Fix the issue (or return the
  job), or use `--no-verify`.

## Development

```sh
npm ci
npm run check    # typecheck, biome, tests with coverage gates, no it.todo left, bundle is fresh
npm run mutate   # Stryker mutation testing on src/domain (break threshold 90%)
npm run build    # rebuild plugins/zai/dist/zai.js (committed, so installs need no build step)
```

The code is TypeScript in strict mode, built as a functional core with an imperative shell:

- `src/domain/`: pure logic, with no I/O. Briefs, the lifecycle state machine, verification, prompts, stream parsing,
  the AIMD limiter and the report schemas.
- `src/ports/`: interfaces for the worker, git, gates, store, clock and process control.
- `src/adapters/`: headless Claude Code, git CLI, shell gates and the file store, with locks and slots.
- `src/app/`: use cases (submit, drive, accept, return, discard, stop, queries, batch).
- `src/render/` and `src/cli/`: output and the command line.

Tests run with Vitest. A fake `claude` binary (`test/support/fake-claude.ts`) replays recorded Z.ai stream fixtures,
so the suite needs no network and no key. The e2e tests drive real git repositories through the whole loop. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the design in depth.

The `.claude/skills/` plugin-development skills used while building this are not included. Install them with
`npx skills add anthropics/claude-code` if you want them.

## License

[GPL-3.0-or-later](LICENSE). Copyright (C) 2026 Raouf.
