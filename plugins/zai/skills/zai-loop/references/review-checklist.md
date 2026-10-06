# Review checklist

Review from evidence, never from the worker's account of itself. Load the packet with the diff:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/zai.js" review <id> --diff
```

The packet holds: header (id, title, model, mode, attempt n of m, verdict), the worker's report summary and open
items, the gate table (failing output inline), the scope result, the change list, usage, and the exact next commands.
Large diffs are truncated with a marker; read the rest in the job's worktree (`show <id>` gives the workspace).

## Verdicts

| Verdict | Meaning | Usual decision |
|---|---|---|
| `pass` | every gate passed, change set within scope, report valid | review the diff; accept or return |
| `gate_fail` | a gate failed after the automatic fix rounds | return with the failing output and the cause, or discard if the approach is wrong |
| `scope_violation` | files outside `scope`, inside `forbid`, or (exec/readonly) the repository changed | return asking to revert those paths; if the scope was too narrow, discard and resubmit a corrected brief |
| `report_invalid` | missing or malformed final report | if the diff is good, return asking for the report only |
| `worker_error` | API error or crash | check `usage` and `setup`; return to retry, or discard |
| `timeout` | an attempt exceeded the brief's timeout | the task is too big: discard and split it, or return with a narrower next step |
| `stopped` | stopped by `stop` | partial work: return to continue, or discard |

`pass` means the gates passed, not that the work is right. Gates prove only what they test.

## Checklist

1. **Diff, not report.** Read every hunk. The report summarises intentions; the diff is what lands.
2. **Goal met.** Each "done when" criterion of the brief is visibly satisfied in the diff or the gate output.
3. **Tests assert behaviour.** New or changed tests check outcomes that would fail without the change. Watch for
   deleted or weakened assertions, `skip`/`only`, expectations rewritten to match the output, snapshots accepted
   wholesale, mocks that make the test tautological.
4. **Re-run one gate yourself** for risky changes (data migrations, concurrency, security-adjacent code, public API):
   run the most specific gate in the job's worktree and compare with the packet.
5. **Scope creep.** No unrelated refactors, mass reformatting, renamed files nobody asked for, new dependencies, edited
   lockfiles, CI or config changes. A clean scope check does not rule out creep inside the allowed globs.
6. **Secrets and leftovers.** No keys, tokens, passwords, internal URLs, `.env` content; no debug prints, commented-out
   code, TODOs standing in for the work.
7. **Consistency.** The change follows the pattern the brief named: naming, error handling, file layout, comments.
8. **Open items.** Read the report's open items; each is either acceptable, a reason to return, or a follow-up.
9. **Sweeps.** Spot-check at least three items against the source, including one `ok`; every `gap` has a reason.

## Decision

- **Accept** when all of the above hold. Small wording or style nits are not worth a round trip; fix them yourself
  after accepting.
- **Return** when the work is fixable within the brief.
- **Discard** when the approach is wrong, the brief was wrong, or two returns did not fix the same problem.

## Feedback for `return`

The worker resumes its own session, so it remembers the brief and its work; send only what must change.

```text
1. src/users/repo.ts:57: findUser now throws on a missing id; it must return undefined as before (Done when #1).
2. test/users/find.test.ts:12: the test asserts the mock was called, not the returned user; assert the value.
3. Revert the formatting changes in src/server.ts; it is outside the task.
Keep the rename itself and the call-site updates as they are.
```

Rules: one numbered item per problem; `file:line`, what is wrong, what correct looks like; cite the failing gate or
the done-criterion; say what to keep. No praise, no questions, no restating the brief.
