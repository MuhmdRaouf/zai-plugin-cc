# Brief guide

A brief is the unit of work: Markdown with YAML front matter, the body being the task. The worker (GLM via headless
Claude Code) sees only the body plus a fixed footer the plugin appends (workspace rules, scope and forbid, the gates
the plugin will run, no commits, no secrets, end with the report). It sees nothing of the orchestrator's conversation.

Start from a template and lint before submitting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" brief new '<title>' --mode edit
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" brief lint <path>
```

## Front matter

Unknown keys are rejected (typo protection).

| Field | Default | Meaning |
|---|---|---|
| `title` | required | short name, shown on the board |
| `model` | `glm` for edit, `flash` otherwise | `glm` = glm-5.3, `flash` = glm-5.3-flash |
| `effort` | unset | `low`, `medium` or `high` |
| `mode` | `edit` | `edit`: own git worktree on branch `zai/<id>`, may change files. `exec`: may run commands, must not change the repository (outputs to `$ZAI_ARTIFACTS`). `readonly`: read tools only |
| `cwd` | current git root | repository the job works on |
| `base` | `HEAD` | ref the worktree starts from |
| `scope` | `["**"]` for edit, `[]` otherwise | globs the change set may touch |
| `forbid` | `[]` | globs that must stay untouched even inside scope |
| `gates` | `[]` | commands the plugin runs in the workspace after the worker: a string or `{run, timeout}` (default timeout 10m) |
| `timeout` | `2h` | per attempt: `90s`, `15m`, `2h`, `1h30m` |
| `retries` | `{fix: 1, infra: 2}` | automatic fix rounds after a failed verdict; re-runs after infrastructure errors |
| `report` | `change` / `sweep` / `notes` by mode | built-in report schema, or a path to a JSON-schema file |
| `addDirs` | `[]` | extra readable directories |
| `env` | `[]` | names of environment variables passed to the worker and gates (values are never stored) |
| `budgetUsd` | unset | spending cap per attempt |
| `tags` | `[]` | free labels for grouping on the board |

Built-in reports: `change` = summary, files with why, optional root cause, tests added, open items. `sweep` = summary,
items `{id, status: ok|fail|gap, detail}`, open items. `notes` = summary, findings with refs, open items.

## Body

Use these sections, in this order:

1. `## Goal`: the observable outcome in one paragraph. Not "improve X", but what is true when done.
2. `## Context`: exact paths; the existing pattern to copy, with a `file:line` example; constraints and decisions
   already made (quote them); what not to touch and why.
3. `## Steps`: numbered, concrete, in the order a careful engineer would do them.
4. `## Done when`: checkable criteria, each tied to a gate or a file. Include "no other files change".
5. `## Assumptions` (when any): readings of an ambiguous request, so the reviewer can check them.

## Gates

Gates are the evidence. The plugin runs them itself after every attempt, so the worker cannot claim them.

- Use the repository's own commands (package.json scripts, Makefile, CI config), run non-interactively from the root.
- Put the narrowest proof first: the targeted test file, then typecheck, then lint. Full suites only when fast.
- A gate must fail without the change. "Tests pass" on untouched tests proves only that nothing broke; when behaviour
  is added, the brief must require a test for it, and the gate must run that test.
- Give slow gates an explicit timeout: `{run: "npm test", timeout: 20m}`.

## Example: edit

```markdown
---
title: Rename getUserById to findUser
mode: edit
model: glm
scope: ["src/**", "test/**"]
forbid: ["package-lock.json", ".github/**"]
gates:
  - npx tsc --noEmit
  - npx vitest run test/users
report: change
---

## Goal
`getUserById` no longer exists; every caller uses `findUser`, with identical behaviour.

## Context
- Defined in `src/users/repo.ts:42`; about 30 call sites under `src/` and `test/` (`grep -rn getUserById`).
- Keep the signature `(id: UserId) => Promise<User | undefined>`.
- The HTTP route name `/users/:id` stays as it is.

## Steps
1. Rename the function and its export in `src/users/repo.ts`.
2. Update every import and call site, including tests.
3. Update the JSDoc that mentions the old name.

## Done when
- `grep -rn getUserById src test` finds nothing.
- Both gates pass; no files outside `src/` and `test/` change.
```

## Example: exec sweep

```markdown
---
title: Inventory v1 billing API callers
mode: exec
model: flash
report: sweep
---

## Goal
A complete list of call sites of the v1 billing client, so the migration can be planned.

## Items
One item per call site of `BillingV1Client` methods under `services/*/src/`.

## Rule
- `ok`: the call is behind the `billing_v2` feature flag (example: `services/cart/src/pay.ts:18`).
- `fail`: unconditional v1 call.
- `gap`: cannot tell (dynamic dispatch, generated code); say why.

## Output
`detail`: `file:line`, the method called, and the enclosing function. Also write the full table to
`$ZAI_ARTIFACTS/billing-v1.md`.

## Done when
Every service directory is examined, and the summary states how many were.
```

## Anti-patterns

- "See the discussion above" or "as we agreed": the worker has no conversation. Write it out.
- `scope: ["**"]` for a narrow change: scope violations are the cheapest bug detector there is.
- No gates, or only a lint gate for a behaviour change.
- Several unrelated goals in one brief: split them into a batch.
- Asking the worker to decide something ("pick the best approach"): decide in the brief, or do not delegate.
- Secrets or tokens in the body; use `env` with variable names.
