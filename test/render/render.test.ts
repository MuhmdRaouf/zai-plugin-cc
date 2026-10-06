import { describe, expect, it } from "vitest";
import type { BoardRow, ReviewPacket } from "../../src/app/queries.ts";
import type { Attempt, Job } from "../../src/domain/job.ts";
import { INITIAL_PROGRESS } from "../../src/domain/stream.ts";
import type { TierUsage } from "../../src/domain/usage.ts";
import {
  renderBoard,
  renderHook,
  renderJob,
  renderReview,
  renderStarted,
  renderSummary,
  renderUsage,
} from "../../src/render/index.ts";
import {
  aBrief,
  aChangeSet,
  aGateResult,
  aJob,
  anAttempt,
  aReportCheck,
  aScopeCheck,
  aVerification,
} from "../support/builders.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const USAGE = {
  turns: 3,
  inputTokens: 4200,
  outputTokens: 310,
  cacheReadTokens: 2800,
  cacheWriteTokens: 900,
  costUsd: 0.0123,
  rateLimitRetries: 0,
  durationMs: 42_130,
};

const REPORT = {
  summary: "Renamed foo to bar in 3 files",
  files: [{ path: "src/a.ts", why: "rename" }],
  tests_added: ["test/a.test.ts"],
  open_items: ["docs still say foo"],
};

function passed(overrides: Partial<Attempt> = {}): Attempt {
  return anAttempt({
    endedAt: ago(5 * MIN),
    outcome: { kind: "completed" },
    usage: USAGE,
    report: REPORT,
    verification: aVerification({
      gates: [
        aGateResult({ run: "npm test", durationMs: 1200 }),
        aGateResult({ run: "npm run lint", durationMs: 400 }),
      ],
      changes: aChangeSet({
        added: ["src/b.ts"],
        modified: ["src/a.ts"],
        deleted: ["old.ts"],
        untracked: ["notes.md"],
      }),
    }),
    verdict: "pass",
    ...overrides,
  });
}

function gateFailed(n = 1): Attempt {
  return passed({
    n,
    verification: aVerification({
      gates: [
        aGateResult({
          run: "npm test",
          exitCode: 1,
          durationMs: 2300,
          tail: "FAIL test/a.test.ts\nexpected 2, got 1\n",
        }),
        aGateResult({ run: "npm run lint", durationMs: 400 }),
      ],
      changes: aChangeSet({ modified: ["src/a.ts"] }),
    }),
    verdict: "gate_fail",
  });
}

function reviewJob(attempts: readonly Attempt[], overrides: Partial<Job> = {}): Job {
  return aJob({
    id: "261006-abc123",
    state: "awaiting_review",
    createdAt: ago(20 * MIN),
    updatedAt: ago(5 * MIN),
    workspace: {
      repoRoot: "/repo",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      worktree: "/state/worktrees/261006-abc123",
      branch: "zai/261006-abc123",
      artifactsDir: "/state/jobs/261006-abc123/artifacts",
    },
    attempts,
    ...overrides,
  });
}

const ESC = String.fromCharCode(27);

describe("renderers", () => {
  it("renderBoard: aligned columns id, state/verdict, model, attempt, age, title; stale drivers flagged; snapshot", () => {
    const rows: BoardRow[] = [
      {
        job: aJob({
          id: "261006-run001",
          state: "running",
          createdAt: ago(3 * MIN),
          attempts: [anAttempt(), anAttempt({ n: 2, kind: "auto_fix" })],
        }),
        progress: {
          ...INITIAL_PROGRESS,
          phase: "tool",
          lastTool: "Bash npm test",
          toolCalls: 7,
          toolErrors: 1,
          rateLimitRetries: 2,
        },
        live: true,
      },
      { job: reviewJob([passed()]), live: false },
      {
        job: aJob({
          id: "261006-old001",
          state: "verifying",
          createdAt: ago(26 * HOUR),
          brief: aBrief({ title: "Sweep call sites", model: "flash", mode: "exec" }),
          attempts: [anAttempt()],
        }),
        live: false,
      },
      { job: aJob({ id: "261006-new001", state: "queued", createdAt: ago(10_000) }), live: true },
    ];

    expect(renderBoard(rows, NOW)).toMatchInlineSnapshot(`
      "ID             STATE              MODEL          MODE  ATT  AGE  TITLE
      261006-run001  running            glm-5.3        edit  2    3m   Rename the helper
        > tool Bash npm test · 7 tool calls (1 failed) · 2 rate-limit retries
      261006-abc123  review: pass       glm-5.3        edit  1    20m  Rename the helper
      261006-old001  verifying (stale)  glm-5.3-flash  exec  1    1d   Sweep call sites
      261006-new001  queued             glm-5.3        edit  0    now  Rename the helper

      stale: 1 job has no live driver (261006-old001); /zai:stop <id> moves one to review, /zai:discard <id> drops it."
    `);
  });

  it("renderBoard: empty board says so and how to start a job", () => {
    expect(renderBoard([], NOW)).toMatchInlineSnapshot(
      `"No zai jobs yet. Start one with /zai:run <brief.md>, or ask for the zai:glm agent."`,
    );
  });

  it("renderReview: header, report summary and open items, gate table with failing tails, scope, changes, usage, next actions; snapshot pass + gate_fail", () => {
    const pass: ReviewPacket = {
      job: reviewJob([gateFailed(), passed({ n: 2, kind: "auto_fix" })]),
      diffStat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
      diff: "diff --git a/src/a.ts b/src/a.ts\n-foo\n+bar\n",
    };
    const fail: ReviewPacket = { job: reviewJob([gateFailed()]) };

    expect(renderReview(pass)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict pass · glm-5.3 · edit · attempt 2 (auto_fix) · awaiting review
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Attempts
        #1 (initial): gate_fail; gates 1/2 passed (failing: \`npm test\`); 1 changed path, in scope; report valid.
        #2 (auto_fix): pass; gates 2/2 passed; 4 changed paths, in scope; report valid.

      Report
        Renamed foo to bar in 3 files
        Tests added: test/a.test.ts
        Open items:
        - docs still say foo

      Gates (2/2 passed)
        pass  npm test      exit 0  1.2s
        pass  npm run lint  exit 0  0.4s

      Scope: in scope
      Changes (4):
        A src/b.ts
        M src/a.ts
        D old.ts
        ? notes.md

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · $0.0123 · 42s

      Diff stat
         src/a.ts | 2 +-
         1 file changed, 1 insertion(+), 1 deletion(-)

      Diff
      \`\`\`diff
      diff --git a/src/a.ts b/src/a.ts
      -foo
      +bar
      \`\`\`

      Next
        /zai:accept 261006-abc123
        /zai:return 261006-abc123 <feedback>
        /zai:discard 261006-abc123 --reason <why>"
    `);
    expect(renderReview(fail)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict gate_fail · glm-5.3 · edit · attempt 1 (initial) · awaiting review
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Report
        Renamed foo to bar in 3 files
        Tests added: test/a.test.ts
        Open items:
        - docs still say foo

      Gates (1/2 passed)
        FAIL  npm test      exit 1  2.3s
          | FAIL test/a.test.ts
          | expected 2, got 1
        pass  npm run lint  exit 0  0.4s

      Scope: in scope
      Changes (1):
        M src/a.ts

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · $0.0123 · 42s

      Next
        /zai:accept 261006-abc123 --force   (verdict gate_fail: only if you accept it anyway)
        /zai:return 261006-abc123 <feedback>
        /zai:discard 261006-abc123 --reason <why>"
    `);
  });

  it("renderReview: scope violations, an invalid report and a worker error are spelled out", () => {
    const attempt = passed({
      outcome: { kind: "api_error", message: "API Error: Request rejected (429)", status: 429 },
      usage: { ...USAGE, rateLimitRetries: 10 },
      report: undefined,
      verification: aVerification({
        scope: aScopeCheck({ outOfScope: ["package.json"], forbidden: [".env"] }),
        report: aReportCheck({ present: false, valid: false, problems: ["no structured report"] }),
        changes: aChangeSet({ modified: ["package.json", ".env"] }),
      }),
      verdict: "worker_error",
    });
    const exec = reviewJob([attempt], {
      brief: aBrief({ mode: "exec", scope: [] }),
      workspace: { repoRoot: "/repo", baseSha: "0".repeat(40), artifactsDir: "/state/jobs/x/artifacts" },
    });
    const changed = passed({
      report: { summary: "x", open_items: [] },
      verification: aVerification({
        scope: aScopeCheck({ repoChanged: true }),
        report: aReportCheck({ valid: false, problems: ["items: Invalid input"] }),
      }),
      verdict: "scope_violation",
    });

    expect(renderReview({ job: exec })).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict worker_error · glm-5.3 · exec · attempt 1 (initial) · awaiting review
      repository /repo (must stay unchanged), artifacts /state/jobs/x/artifacts

      Worker: API error (429): API Error: Request rejected (429)

      Report: missing (the worker ended without a structured report)

      Gates: none run

      Scope: VIOLATED, out of scope: package.json; forbidden: .env
      Changes (2):
        M package.json
        M .env

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · $0.0123 · 42s · 10 rate-limit retries

      Next
        /zai:accept 261006-abc123 --force   (verdict worker_error: only if you accept it anyway)
        /zai:return 261006-abc123 <feedback>
        /zai:discard 261006-abc123 --reason <why>"
    `);
    expect(renderReview({ job: reviewJob([changed], { state: "running" }) })).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict scope_violation · glm-5.3 · edit · attempt 1 (initial) · running
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Report
        x
        Open items: none
        Invalid against its contract:
        - items: Invalid input

      Gates: none run

      Scope: VIOLATED, the repository changed (this job must leave it unchanged)
      Changes: none

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · $0.0123 · 42s

      Not awaiting review (running); /zai:show 261006-abc123 follows it."
    `);
  });

  it("renderSummary: verdict first, then files changed count, gates line, next actions; under 25 lines", () => {
    const many = aChangeSet({ modified: Array.from({ length: 14 }, (_, i) => `src/file-${i}.ts`) });
    const pass = reviewJob([gateFailed(), passed({ n: 2, kind: "auto_fix" })]);
    const failed = reviewJob([
      gateFailed(),
      {
        ...gateFailed(2),
        kind: "auto_fix",
        verification: aVerification({ changes: many, gates: [aGateResult({ exitCode: 1 })] }),
      },
    ]);
    const crashed = reviewJob([
      anAttempt({
        outcome: { kind: "crashed", exitCode: 1, signal: null, stderrTail: "Error: boom\n" },
        verification: aVerification(),
        verdict: "worker_error",
      }),
    ]);

    expect(renderSummary(pass)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict pass (awaiting review)
      Rename the helper (glm-5.3, edit); 2 attempts: #1 initial gate_fail, #2 auto_fix pass
      Changed 4 files: notes.md, old.ts, src/a.ts, src/b.ts
      Gates: 2/2 passed
      Report: Renamed foo to bar in 3 files (1 open item)
      Next: /zai:review 261006-abc123 (read the diff), then /zai:accept 261006-abc123, /zai:return 261006-abc123 <feedback> or /zai:discard 261006-abc123 --reason <why>"
    `);
    expect(renderSummary(failed)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict gate_fail (awaiting review)
      Rename the helper (glm-5.3, edit); 2 attempts: #1 initial gate_fail, #2 auto_fix gate_fail
      Changed 14 files: src/file-0.ts, src/file-1.ts, src/file-10.ts, src/file-11.ts, src/file-12.ts, src/file-13.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts, src/file-5.ts and 4 more
      Gates: 0/1 passed; failing: npm test
      Report: Renamed foo to bar in 3 files (1 open item)
      Next: /zai:review 261006-abc123 (read the diff), then /zai:accept 261006-abc123 --force, /zai:return 261006-abc123 <feedback> or /zai:discard 261006-abc123 --reason <why>"
    `);
    expect(renderSummary(crashed)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict worker_error (awaiting review)
      Rename the helper (glm-5.3, edit); 1 attempt: #1 initial worker_error
      Worker: crashed (exit 1): Error: boom
      Changed: nothing
      Gates: none
      Report: (no summary)
      Next: /zai:review 261006-abc123 (read the diff), then /zai:accept 261006-abc123 --force, /zai:return 261006-abc123 <feedback> or /zai:discard 261006-abc123 --reason <why>"
    `);
    for (const job of [pass, failed, crashed]) {
      expect(renderSummary(job).split("\n").length).toBeLessThan(25);
    }
  });

  it("renderUsage: one row per tier with rates as percentages, n/a for null; snapshot", () => {
    const glm: TierUsage = {
      tier: "glm",
      jobs: 5,
      decided: 4,
      accepted: 3,
      discarded: 1,
      firstTryPassRate: 0.5,
      acceptRate: 0.75,
      meanAttemptsToAccept: 1.6666,
      reviewReturns: 2,
      inputTokens: 1_234_567,
      outputTokens: 45_600,
      cacheReadTokens: 980,
      costUsd: 3.456,
      rateLimitRetries: 12,
      durationMs: 3_600_000,
    };
    const flash: TierUsage = {
      ...glm,
      tier: "flash",
      jobs: 1,
      decided: 0,
      accepted: 0,
      discarded: 0,
      firstTryPassRate: null,
      acceptRate: null,
      meanAttemptsToAccept: null,
      reviewReturns: 0,
      costUsd: 0.0042,
      rateLimitRetries: 0,
    };

    expect(renderUsage([glm, flash])).toMatchInlineSnapshot(`
      "MODEL          JOBS  DECIDED  ACCEPTED  DISCARDED  1ST-TRY  ACCEPT  ATT/ACC  RETURNS  IN    OUT    CACHE  COST     429S  TIME
      glm-5.3        5     4        3         1          50%      75%     1.7      2        1.2M  45.6k  980    $3.46    12    1h00m
      glm-5.3-flash  1     0        0         0          n/a      n/a     n/a      0        1.2M  45.6k  980    $0.0042  0     1h00m"
    `);
    expect(renderUsage([])).toMatchInlineSnapshot(`"No zai jobs yet: nothing to report."`);
  });

  it("renderStarted, renderHook and renderJob: the one-liners and the job view", () => {
    const running: BoardRow = {
      job: aJob({
        id: "261006-run001",
        state: "running",
        createdAt: ago(3 * MIN),
        updatedAt: ago(MIN),
        attempts: [gateFailed(), anAttempt({ n: 2, kind: "auto_fix" })],
      }),
      progress: { ...INITIAL_PROGRESS, phase: "writing", lastText: "Now I will\nupdate the tests", turns: 4 },
      live: true,
    };
    const review: BoardRow = { job: reviewJob([passed()]), live: false };

    expect(renderStarted(reviewJob([]))).toBe(
      "zai job 261006-abc123 started: Rename the helper (glm-5.3, edit)",
    );
    expect(renderHook([running, review, running])).toMatchInlineSnapshot(
      `"zai: 1 job awaits review (/zai:review 261006-abc123); 2 jobs queued or running. /zai:board lists them."`,
    );
    expect(renderHook([{ job: aJob({ state: "accepted" }), live: false }])).toBe("");
    expect(renderJob(running, NOW)).toMatchInlineSnapshot(`
      "zai job 261006-run001: Rename the helper
      running · glm-5.3 · edit · created 3m ago · updated 1m ago
      workspace /state/worktrees/j1
      Attempts:
        #1 (initial): gate_fail; gates 1/2 passed (failing: \`npm test\`); 1 changed path, in scope; report valid.
        #2 (auto_fix): no verdict; not verified.
      Progress: writing
        "Now I will update the tests""
    `);
    expect(renderJob({ job: running.job, live: false }, NOW)).toContain("stale");
  });

  it("no ANSI escape codes in any output", () => {
    const job = reviewJob([gateFailed(), passed({ n: 2 })]);
    const outputs = [
      renderBoard([{ job, live: true }], NOW),
      renderReview({ job, diff: "+x\n", diffStat: " a | 1 +\n" }),
      renderSummary(job),
      renderJob({ job, live: true }, NOW),
      renderUsage([
        {
          tier: "glm",
          jobs: 1,
          decided: 1,
          accepted: 1,
          discarded: 0,
          firstTryPassRate: 1,
          acceptRate: 1,
          meanAttemptsToAccept: 2,
          reviewReturns: 0,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 1,
          costUsd: 1,
          rateLimitRetries: 0,
          durationMs: 1,
        },
      ]),
    ];

    for (const output of outputs) expect(output).not.toContain(ESC);
  });
});
