# zai — architecture

GLM (Z.ai) does bulk mechanical work. Claude orchestrates, verifies the evidence, reviews, and either accepts the work or
sends it back with feedback. This plugin is the machinery between them. It is deliberately boring: deterministic
verification, explicit state, no trust in what a worker says about itself.

## Roles

| Role | Who | Nature |
|---|---|---|
| Orchestrator | Claude (main session) | decides what to delegate, writes/approves briefs, dispatches batches |
| Dispatcher | `zai:glm` / `zai:glm-flash` subagents (Sonnet) | turns a request into a brief, submits it, waits in the background, returns the review packet |
| Worker | GLM via headless Claude Code (`claude -p` against Z.ai) | does the work in an isolated workspace, ends with a structured report |
| Verifier | this plugin, deterministic code | runs the brief's gates itself, checks the diff against scope/forbid, validates the report |
| Reviewer | Claude | reads the review packet, then `accept`, `return` (with feedback) or `discard` |

Verification is mechanical; review is judgment. The plugin never decides acceptance, and Claude never has to take a
worker's "done" on faith.

## The loop

```
 brief ──submit──▶ queued ──slot──▶ running ──worker exits──▶ verifying ──▶ awaiting_review ──accept──▶ accepted
                                     ▲                          │  verdict≠pass and                │
                                     │                          │  fix budget left                  ├─return(feedback)─┐
                                     └──── auto-fix attempt ◀───┘                                   │                  │
                                     └──── review-fix attempt (same GLM session, feedback) ◀────────┼──────────────────┘
                                                                                                    └─discard──▶ discarded
```

A job always lands in `awaiting_review` with a **verdict** (pass, gate_fail, scope_violation, report_invalid,
worker_error, timeout, stopped): failures are reviewed too, because only Claude decides whether to return or discard.
`stop` moves a running job to `awaiting_review` with verdict `stopped`.

## Brief (unit of work)

Markdown with YAML front matter; the body is the task. Parsed with `yaml`, validated with `zod` into `Brief`.

| Field | Default | Meaning |
|---|---|---|
| `title` | required | short name |
| `model` | `glm` for edit, `flash` otherwise | `glm` = glm-5.3, `flash` = glm-5.3-flash |
| `effort` | unset | `low`/`medium`/`high` → `claude --effort` |
| `mode` | `edit` | `edit`: git worktree + branch `zai/<id>`, worker may change files; `exec`: may run commands, must not change the repo (artifacts dir only); `readonly`: plan mode, read tools only |
| `cwd` | current git root | repository the job works on |
| `base` | `HEAD` | ref the worktree starts from |
| `scope` | `["**"]` for edit, `[]` otherwise | globs the change set may touch |
| `forbid` | `[]` | globs that must stay untouched even inside scope |
| `gates` | `[]` | shell commands the **plugin** runs in the workspace after the worker; string or `{run, timeout}` |
| `timeout` | `2h` | per attempt |
| `retries` | `{fix: 1, infra: 2}` | auto-fix rounds after a failed verdict; re-runs after infrastructure errors |
| `report` | `change` (edit), `sweep` (exec), `notes` (readonly) | built-in schema name or a JSON-schema file; enforced via `--json-schema` |
| `addDirs` | `[]` | extra readable paths → `--add-dir` |
| `env` | `[]` | names of orchestrator env vars passed to worker and gates (values never stored) |
| `budgetUsd` | unset | → `--max-budget-usd` |
| `tags` | `[]` | free labels (batch grouping, board filter) |

The plugin appends a fixed contract footer to every prompt (workspace rules, scope/forbid, the gates it will run, no
commits, no secrets, end with the report). Prompts are pure functions of brief + attempt history (snapshot-tested).

## Job, attempts, verdict

A `Job` holds the immutable brief, the workspace (repo root, base sha, worktree path, branch), state, and `attempts[]`.
Each `Attempt`: number, kind (`initial`/`auto_fix`/`review_fix`/`infra_retry`), prompt, GLM session id, worker outcome
(`completed`/`api_error`/`timeout`/`crashed`/`stopped`, with error text), usage (turns, tokens in/out/cache, cost, 429
retries), structured report, verification (`gates[]` with exit code/duration/output tail, `changes` with
added/modified/deleted/untracked paths, out-of-scope and forbidden paths, report validity) and the derived verdict.

Fix attempts resume the same GLM session (`--resume <session>`) so context carries over; if the session cannot be resumed
the prompt is rebuilt self-contained.

## Workspace

- `edit`: `git worktree add -b zai/<id> <state>/worktrees/<id> <baseSha>`; the change set is
  `git diff --name-status <baseSha>` plus untracked files (worker never commits). `accept` commits the change set on the job
  branch (message from title + report summary, trailer `Worked-by: <model> via zai`) and cherry-picks it onto the
  repository's current branch; conflicts abort cleanly and are reported (return the job to rebase). `accept --no-commit`
  applies it to the working tree instead. `accept`/`discard` remove the worktree.
- `exec`: worker runs in the repository with `bypassPermissions`; verification requires the repository to be unchanged
  (`git status --porcelain` identical before/after); outputs go to `<state>/jobs/<id>/artifacts/` (`$ZAI_ARTIFACTS`).
- `readonly`: `--permission-mode plan`; same unchanged-repository check.

## Worker runtime (Z.ai)

`claude -p --output-format stream-json --verbose --include-partial-messages --model <alias> --json-schema <schema>
--session-id|--resume <id> [--effort] [--add-dir…] [--max-budget-usd]`, prompt on stdin, detached process group.
Environment is an **allowlist** (PATH, HOME, LANG, TERM, SHELL, TMPDIR, USER, brief `env` names) plus
`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN=<key>`, alias mapping
(`ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3`, `…_OPUS_MODEL=glm-5.3`, `…_HAIKU_MODEL=glm-5.3-flash`; the worker runs on the
aliases `sonnet`/`haiku` because raw ids log `unrecognized_model`), `API_TIMEOUT_MS=3000000`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and an isolated `CLAUDE_CONFIG_DIR=<state>/claude-home`. Nothing else from the
orchestrator's environment leaks in (verified by test). The key comes from `ZAI_API_KEY` or `~/.config/zai-plugin-cc/env`
(must be mode 0600) and exists only in the child's environment.

Stream facts the parser relies on (captured live, `test/fixtures/stream/`): `system/init` carries `session_id`, `model`,
`apiKeySource`; `system/api_retry` carries `attempt`, `max_retries`, `error_status` (429 = rate limit, Z.ai code 1302);
`result` carries `is_error` **independently of `subtype`** (`subtype: "success"` with `is_error: true` happens), `result`
text, `structured_output`, `usage`, `total_cost_usd`, `num_turns`.

## Concurrency and rate limits

One Z.ai account budget is shared by every job (and anything else using the key). Jobs run as independent driver
processes; a file-based semaphore (`<state>/slots/`, atomic `wx` create, stale-pid reclaim) caps concurrent workers. The cap
is AIMD-controlled from live `api_retry` 429 events: multiplicative decrease with a cooldown, additive increase after a
quiet period, bounded by `[1, ZAI_MAX_CONCURRENCY]`.

## Execution model

No daemon. Every job is driven by a detached `zai drive <id>` process (own process group): `zai run --bg`, `zai batch` and
`zai run --wait` all spawn one. It is started by a double fork (a `node -e` launcher spawns it detached, prints its pid and
exits), so the driver is reparented to init/launchd and no tree-kill of the caller (Claude Code cleaning up a background
shell: SIGTERM, then SIGKILL, to every descendant) reaches it or its worker. `--wait` then follows the job like `zai wait <id>`: it polls the store (1 s doubling to
5 s) until the job lands and prints the summary. A follower never drives or stops anything, so killing it (SIGKILL, or
SIGINT/SIGTERM, which print how to re-attach) leaves the job running; `wait <id>` re-attaches. A running/verifying job
without a live driver, or a queued one nobody claims for 30 s, is stale: the follower says so and exits 6. The dispatcher
subagent runs `zai run --wait` with Bash `run_in_background` and ends its turn; Claude Code resumes it on completion
(verified 2026-10-06: the subagent emits an interim result, then a final notification), and it returns the packet; if the
command died, it runs `zai wait <id>`, never `run` again. Per-job lock files prevent two drivers on one job.

## Code structure (functional core, imperative shell)

```
src/
  domain/     pure: brief, lifecycle (state machine), verdict, scope, prompt, limiter, usage, progress, report schemas
  ports/      interfaces: Worker, Git, GateRunner, JobStore, Semaphore, Clock, Ids, KeySource, ProcessControl, Output
  adapters/   thin I/O: claude-headless (args, env, spawn), stream-json parser, git-cli, shell-gates, fs-store, fs-semaphore, key-file
  app/        use cases over ports: submit, drive (run→verify→auto-fix), review, accept, return, discard, stop, board, usage, batch
  render/     pure text renderers: board, show, review packet, usage
  cli/        node:util parseArgs, one module per command, exit codes
plugins/zai/  .claude-plugin/plugin.json, agents/, commands/, skills/zai-loop/, hooks/, dist/zai.js (esbuild bundle, committed)
```

Rules: no `any`; no default exports; expected failures are values (`Result<T, E>` with discriminated error unions), never
thrown across a port; adapters contain no decisions; every decision lives in `domain/` or `app/` and is unit-tested with
fakes; adapters get integration tests against real git, real processes (a fake `claude` script replaying fixtures) and a
temp filesystem; one CLI end-to-end test drives brief → worker edit → verify → review → accept in a temp repo.

## Quality gates (`npm run check`)

`tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `biome ci`, `vitest run --coverage`
(domain ≥95% lines/branches, overall ≥90%), no `it.todo` left, `dist/` fresh. `npm run mutate` (Stryker) on `src/domain`
with break threshold 80%.

## Exit codes

0 ok · 1 unexpected · 2 usage · 3 verdict not pass (`run --wait`, `wait`) · 4 not found · 5 conflict (accept) · 6 not ready
(setup; `run --wait`/`wait`: the job has no live driver and needs `stop` or `discard`) · 130 follower interrupted (the job
keeps running).
