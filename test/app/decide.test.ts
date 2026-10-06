import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accept, discard, returnForFix, stop } from "../../src/app/decide.ts";
import { stopRequested } from "../../src/app/job-files.ts";
import type { Brief } from "../../src/domain/brief.ts";
import type { Attempt, Job } from "../../src/domain/job.ts";
import { reviewFixPrompt } from "../../src/domain/prompt.ts";
import { err, ok } from "../../src/domain/result.ts";
import { aBrief, aChangeSet, aJob, anAttempt, aVerification } from "../support/builders.ts";
import {
  BASE_SHA,
  COMMIT_SHA,
  type Fakes,
  fakeDeps,
  PICKED_SHA,
  VALID_CHANGE_REPORT,
} from "../support/fakes.ts";

const ID = "261006-decide";
const COMMIT = { mode: "commit", force: false, verify: true } as const;

function reviewed(overrides: Partial<Attempt> = {}): Attempt {
  return anAttempt({
    sessionId: "s-1",
    endedAt: "2026-10-06T00:10:00.000Z",
    outcome: { kind: "completed" },
    report: VALID_CHANGE_REPORT,
    verification: aVerification({ changes: aChangeSet({ modified: ["src/a.ts"] }) }),
    verdict: "pass",
    ...overrides,
  });
}

function stored(fakes: Fakes, overrides: Partial<Job> = {}, brief: Partial<Brief> = {}): Job {
  const paths = fakes.store.paths(ID);
  const edit = (brief.mode ?? "edit") === "edit";
  return fakes.store.put(
    aJob({
      id: ID,
      brief: aBrief(brief),
      state: "awaiting_review",
      workspace: {
        repoRoot: "/repo",
        baseSha: BASE_SHA,
        ...(edit ? { worktree: paths.worktree, branch: `zai/${ID}` } : {}),
        artifactsDir: paths.artifacts,
      },
      attempts: [reviewed()],
      ...overrides,
    }),
  );
}

function current(fakes: Fakes): Job {
  const job = fakes.store.jobs.get(ID);
  if (job === undefined) throw new Error("job not stored");
  return job;
}

describe("accept", () => {
  it("edit + pass: commits on the job branch with title, summary and Worked-by trailer, cherry-picks, removes worktree, state accepted with commit sha", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    const job = stored(fakes);

    const result = await accept(fakes.deps, "261006-dec", COMMIT);

    const worktree = fakes.store.paths(ID).worktree;
    expect(fakes.git.called("commitAll")).toEqual([
      [worktree, "Rename the helper\n\nRenamed foo to bar\n\nWorked-by: glm-5.3 via zai\n", { verify: true }],
    ]);
    expect(fakes.git.called("cherryPick")).toEqual([["/repo", COMMIT_SHA]]);
    expect(fakes.git.called("removeWorktree")).toEqual([["/repo", worktree, `zai/${ID}`]]);
    expect(result).toEqual(ok(current(fakes)));
    expect(current(fakes)).toMatchObject({
      state: "accepted",
      decision: { kind: "accepted", at: "2026-10-06T00:00:00.000Z", commit: PICKED_SHA },
      version: job.version + 1,
    });
  });

  it("no_commit mode applies to the working tree and records no commit", async () => {
    const fakes = fakeDeps();
    stored(fakes);

    const result = await accept(fakes.deps, ID, { ...COMMIT, mode: "no_commit" });

    expect(result.ok).toBe(true);
    expect(fakes.git.called("applyToWorkingTree")).toEqual([
      ["/repo", fakes.store.paths(ID).worktree, BASE_SHA],
    ]);
    expect(fakes.git.called("commitAll")).toEqual([]);
    expect(current(fakes).decision).toEqual({ kind: "accepted", at: "2026-10-06T00:00:00.000Z" });
  });

  it("conflict → conflict error, job still awaiting_review, worktree kept", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    fakes.git.pickResult = err({ kind: "conflict", paths: ["src/a.ts"] });
    const job = stored(fakes);

    const result = await accept(fakes.deps, ID, COMMIT);

    expect(result).toEqual(err({ kind: "git", error: { kind: "conflict", paths: ["src/a.ts"] } }));
    expect(current(fakes)).toEqual(job);
    expect(fakes.git.called("removeWorktree")).toEqual([]);
    expect(fakes.store.locks.size).toBe(0);
  });

  it("a retried accept after a conflict picks the commit already on the job branch instead of committing again", async () => {
    const fakes = fakeDeps();
    fakes.git.worktreeHead = COMMIT_SHA;
    stored(fakes);

    await accept(fakes.deps, ID, COMMIT);

    expect(fakes.git.called("commitAll")).toEqual([]);
    expect(fakes.git.called("cherryPick")).toEqual([["/repo", COMMIT_SHA]]);
    expect(current(fakes).state).toBe("accepted");
  });

  it("a failing commit hook fails accept cleanly: job stays awaiting_review, the hook output is in the error", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    const hook = { kind: "git_failed", command: "git commit", stderr: "lint: 2 problems" } as const;
    fakes.git.commitResult = err(hook);
    const job = stored(fakes);

    const result = await accept(fakes.deps, ID, COMMIT);
    const skipped = await accept(fakes.deps, ID, { ...COMMIT, verify: false });

    expect(result).toEqual(err({ kind: "git", error: hook }));
    expect(fakes.git.called("cherryPick")).toEqual([]);
    expect(fakes.git.called("commitAll").map((args) => args[2])).toEqual([
      { verify: true },
      { verify: false },
    ]);
    expect(skipped.ok).toBe(false);
    expect(current(fakes)).toEqual(job);
  });

  it("an edit job that changed nothing is accepted without a commit", async () => {
    const fakes = fakeDeps();
    stored(fakes);

    await accept(fakes.deps, ID, COMMIT);

    expect(fakes.git.called("commitAll")).toEqual([]);
    expect(fakes.git.called("cherryPick")).toEqual([]);
    expect(current(fakes).decision).toEqual({ kind: "accepted", at: "2026-10-06T00:00:00.000Z" });
  });

  it("non-pass verdict requires force", async () => {
    const fakes = fakeDeps();
    stored(fakes, { attempts: [reviewed({ verdict: "gate_fail" })] });

    const refused = await accept(fakes.deps, ID, COMMIT);
    const forced = await accept(fakes.deps, ID, { ...COMMIT, force: true });

    expect(refused).toEqual(err({ kind: "not_pass", id: ID, verdict: "gate_fail" }));
    expect(forced.ok && forced.value.state).toBe("accepted");
  });

  it("exec/readonly: accepted without git operations", async () => {
    const fakes = fakeDeps();
    stored(fakes, {}, { mode: "exec", scope: [] });

    const result = await accept(fakes.deps, ID, COMMIT);

    expect(result.ok && result.value.state).toBe("accepted");
    expect(fakes.git.calls).toEqual([]);
  });

  it("wrong state → wrong_state naming allowed states", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "running" });

    expect(await accept(fakes.deps, ID, COMMIT)).toEqual(
      err({ kind: "wrong_state", id: ID, state: "running", allowed: ["awaiting_review"] }),
    );
    expect(await accept(fakes.deps, "nope", COMMIT)).toEqual(
      err({ kind: "store", error: { kind: "not_found", id: "nope" } }),
    );
  });

  it("a worktree that cannot be removed is reported, the acceptance stands", async () => {
    const fakes = fakeDeps();
    fakes.git.removeWorktreeResult = err({
      kind: "git_failed",
      command: "git worktree remove",
      stderr: "busy",
    });
    stored(fakes);

    const result = await accept(fakes.deps, ID, COMMIT);

    expect(result.ok).toBe(true);
    expect(fakes.out.errors).toEqual([
      `zai: job ${ID} is accepted, but its worktree could not be removed: git worktree remove: busy`,
    ]);
  });
});

describe("returnForFix", () => {
  it("awaiting_review → queued with the feedback recorded for the next review_fix attempt", async () => {
    const fakes = fakeDeps();
    const job = stored(fakes);
    writeFileSync(join(fakes.store.paths(ID).dir, "stop"), "");

    const result = await returnForFix(fakes.deps, ID, "  Also rename the tests.  ");

    const last = job.attempts[0];
    if (last === undefined) throw new Error("no attempt");
    expect(result).toEqual(ok(current(fakes)));
    expect(current(fakes).state).toBe("queued");
    expect(current(fakes).attempts[1]).toEqual({
      n: 2,
      kind: "review_fix",
      feedback: "Also rename the tests.",
      prompt: reviewFixPrompt(job.brief, last, "Also rename the tests."),
      sessionId: "s-1",
      startedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(await stopRequested(fakes.store.paths(ID))).toBe(false);
  });

  it("empty or whitespace feedback → empty_feedback", async () => {
    const fakes = fakeDeps();
    stored(fakes);

    expect(await returnForFix(fakes.deps, ID, "")).toEqual(err({ kind: "empty_feedback" }));
    expect(await returnForFix(fakes.deps, ID, " \n\t")).toEqual(err({ kind: "empty_feedback" }));
    expect(current(fakes).state).toBe("awaiting_review");
  });

  it("only an awaiting_review job can be returned", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "accepted" });

    expect(await returnForFix(fakes.deps, ID, "more")).toEqual(
      err({ kind: "wrong_state", id: ID, state: "accepted", allowed: ["awaiting_review"] }),
    );
  });
});

describe("discard and stop", () => {
  it("discard stops a live driver, removes the worktree, keeps logs, state discarded with reason", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "running", attempts: [anAttempt()] });
    const paths = fakes.store.paths(ID);
    writeFileSync(paths.attemptLog(1), "{}\n");
    fakes.store.holdLock(ID, 4242);
    fakes.process.alive.add(4242);

    // A long grace, so the simulated driver below always answers in time on a loaded machine.
    const patient = { ...fakes.deps, config: { ...fakes.deps.config, stopGraceMs: 600_000 } };

    const discarding = discard(patient, ID, "wrong approach");
    // The driver honours the stop request: lands the job in awaiting_review and lets go of its lock.
    await expect.poll(() => stopRequested(paths), { interval: 1 }).toBe(true);
    fakes.store.put({ ...current(fakes), state: "awaiting_review" });
    fakes.store.locks.delete(ID);
    rmSync(join(paths.dir, "driver.lock"));
    const result = await discarding;

    expect(result).toEqual(ok(current(fakes)));
    expect(current(fakes)).toMatchObject({
      state: "discarded",
      decision: { kind: "discarded", reason: "wrong approach" },
    });
    expect(fakes.git.called("removeWorktree")).toEqual([["/repo", paths.worktree, `zai/${ID}`]]);
    expect(existsSync(paths.attemptLog(1))).toBe(true);
    expect(fakes.process.terminated).toEqual([]);
  });

  it("discard of a job whose driver died needs no stop; without a reason none is recorded", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "verifying" }, { mode: "readonly", scope: [] });

    const result = await discard(fakes.deps, ID);

    expect(result.ok && result.value.decision).toEqual({ kind: "discarded", at: "2026-10-06T00:00:00.000Z" });
    expect(fakes.git.calls).toEqual([]);
  });

  it("a driver that ignores the stop request is terminated; still holding the lock is an error", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "running", attempts: [anAttempt()] });
    fakes.store.holdLock(ID, 4242);

    const result = await discard(fakes.deps, ID, "stuck");

    expect(fakes.process.terminated).toEqual([4242]);
    expect(result).toEqual(err({ kind: "store", error: { kind: "locked", id: ID, holderPid: 4242 } }));
    expect(current(fakes).state).toBe("running");
  });

  it("decided jobs cannot be discarded", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "discarded" });

    expect(await discard(fakes.deps, ID)).toEqual(
      err({
        kind: "wrong_state",
        id: ID,
        state: "discarded",
        allowed: ["queued", "running", "verifying", "awaiting_review"],
      }),
    );
  });

  it("stop writes the stop request; a queued job goes straight to awaiting_review with verdict stopped", async () => {
    const fakes = fakeDeps();
    const running = stored(fakes, { state: "running", attempts: [anAttempt()] });
    fakes.store.holdLock(ID, 4242);

    const requested = await stop(fakes.deps, ID);

    expect(requested).toEqual(ok(running));
    expect(await stopRequested(fakes.store.paths(ID))).toBe(true);

    const idle = fakeDeps();
    stored(idle, { state: "queued", attempts: [] });

    const stopped = await stop(idle.deps, ID);

    expect(stopped.ok && stopped.value.state).toBe("awaiting_review");
    expect(stopped.ok && stopped.value.attempts).toMatchObject([
      { n: 1, kind: "initial", outcome: { kind: "stopped" }, verdict: "stopped" },
    ]);
    expect(await stopRequested(idle.store.paths(ID))).toBe(false);
  });

  it("stop of a running job whose driver died closes the attempt in flight as stopped", async () => {
    const fakes = fakeDeps();
    stored(fakes, { state: "running", attempts: [anAttempt({ prompt: "do it" })] });

    const result = await stop(fakes.deps, ID);

    expect(result.ok && result.value.attempts).toMatchObject([
      { n: 1, prompt: "do it", outcome: { kind: "stopped" }, verdict: "stopped" },
    ]);
  });

  it("only queued, running or verifying jobs can be stopped", async () => {
    const fakes = fakeDeps();
    stored(fakes);

    expect(await stop(fakes.deps, ID)).toEqual(
      err({
        kind: "wrong_state",
        id: ID,
        state: "awaiting_review",
        allowed: ["queued", "running", "verifying"],
      }),
    );
    expect(await stopRequested(fakes.store.paths(ID))).toBe(false);
  });
});
