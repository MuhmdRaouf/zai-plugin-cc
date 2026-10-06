import type { Job } from "../domain/job.ts";
import { MODELS } from "../domain/model.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { changedPaths } from "../domain/verify.ts";
import type { GitError } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import { type AppError, describeGitError } from "./errors.ts";
import { reportFacts } from "./report-facts.ts";

export type AcceptMode = "commit" | "no_commit";

/** A job branch this far ahead of its base was not made by accept. */
const MAX_JOB_COMMITS = 50;

const gitError = (error: GitError): Result<never, AppError> => err({ kind: "git", error });

/**
 * Lands an edit job's change set in its repository; returns the repository's new commit (commit mode) if one was made.
 * commit: commits whatever is not yet committed on the job branch, then cherry-picks every job-branch commit (a
 * previous accept may have committed before its pick conflicted). no_commit: applies the change set to the working
 * tree. exec/readonly jobs have nothing to land.
 */
export async function land(
  deps: Deps,
  job: Job,
  opts: { readonly mode: AcceptMode; readonly verify: boolean },
): Promise<Result<string | undefined, AppError>> {
  const { repoRoot, worktree, baseSha } = job.workspace;
  if (worktree === undefined) return ok(undefined);
  if (opts.mode === "no_commit") {
    const applied = await deps.git.applyToWorkingTree(repoRoot, worktree, baseSha);
    return applied.ok ? ok(undefined) : gitError(applied.error);
  }
  const committed = await commitPending(deps, job, worktree, opts.verify);
  if (!committed.ok) return committed;
  const commits = await jobCommits(deps, worktree, baseSha);
  if (!commits.ok) return commits;
  let picked: string | undefined;
  for (const sha of commits.value) {
    const result = await deps.git.cherryPick(repoRoot, sha);
    if (!result.ok) return gitError(result.error);
    picked = result.value;
  }
  return ok(picked);
}

async function commitPending(
  deps: Deps,
  job: Job,
  worktree: string,
  verify: boolean,
): Promise<Result<void, AppError>> {
  const head = await deps.git.resolve(worktree, "HEAD");
  if (!head.ok) return gitError(head.error);
  const pending = await deps.git.changes(worktree, head.value);
  if (!pending.ok) return gitError(pending.error);
  if (changedPaths(pending.value).length === 0) return ok(undefined);
  const commit = await deps.git.commitAll(worktree, commitMessage(job), { verify });
  return commit.ok ? ok(undefined) : gitError(commit.error);
}

/** The job branch's commits since the base, oldest first. */
async function jobCommits(
  deps: Deps,
  worktree: string,
  baseSha: string,
): Promise<Result<readonly string[], AppError>> {
  const newestFirst: string[] = [];
  for (let back = 0; back < MAX_JOB_COMMITS; back++) {
    const sha = await deps.git.resolve(worktree, back === 0 ? "HEAD" : `HEAD~${back}`);
    if (!sha.ok) return gitError(sha.error);
    if (sha.value === baseSha) return ok(newestFirst.reverse());
    newestFirst.push(sha.value);
  }
  return gitError({
    kind: "git_failed",
    command: "git rev-parse",
    stderr: `the job branch is more than ${MAX_JOB_COMMITS} commits ahead of ${baseSha}`,
  });
}

/** Title, the report's summary, and the trailer naming the model that did the work. */
export function commitMessage(job: Job): string {
  const { summary } = reportFacts(job.attempts.at(-1)?.report);
  const trailer = `Worked-by: ${MODELS[job.brief.model].zaiId} via zai`;
  return `${[job.brief.title, ...(summary === undefined ? [] : [summary]), trailer].join("\n\n")}\n`;
}

/** Removes an edit job's worktree and branch once decided; a failure is reported, the decision stands. */
export async function removeWorkspace(deps: Deps, job: Job): Promise<void> {
  const { repoRoot, worktree, branch } = job.workspace;
  if (worktree === undefined || branch === undefined) return;
  const removed = await deps.git.removeWorktree(repoRoot, worktree, branch);
  if (!removed.ok) {
    deps.out.error(
      `zai: job ${job.id} is ${job.state}, but its worktree could not be removed: ${describeGitError(removed.error)}`,
    );
  }
}
