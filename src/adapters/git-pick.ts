import { err, type Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { splitNul } from "./git-parse.ts";
import { type GitRun, gitError, gitText, gitValue, gitVoid, runGit } from "./git-run.ts";
import { blockingPaths } from "./git-status.ts";

/** A pick that stopped half-way: report its unmerged paths, then abort so repo is exactly as before. */
async function abortStoppedPick(
  repo: string,
  args: readonly string[],
  failed: Extract<GitRun, { ok: false }>,
): Promise<Result<never, GitError>> {
  const unmerged = await gitText(repo, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const aborted = await gitVoid(repo, ["cherry-pick", "--abort"]);
  if (!aborted.ok) return aborted;
  const paths = unmerged.ok ? splitNul(unmerged.value) : [];
  // Stopped without unmerged paths (e.g. the change is already there and the pick came out empty): not a conflict.
  return err(paths.length > 0 ? { kind: "conflict", paths } : gitError(repo, args, failed));
}

/** Cherry-picks sha onto repo's current branch. Refuses up front (dirty, nothing changed) when staged changes or dirty
 *  files the commit touches are in the way, since git would refuse too, less precisely. */
export async function cherryPick(repo: string, sha: string): Promise<Result<string, GitError>> {
  const touched = await gitText(repo, [
    "diff-tree",
    "-r",
    "--root",
    "--no-commit-id",
    "--name-only",
    "-z",
    sha,
  ]);
  if (!touched.ok) return touched;
  const blocked = await blockingPaths(repo, splitNul(touched.value), { stagedAnywhere: true });
  if (!blocked.ok) return blocked;
  if (blocked.value.length > 0) return err({ kind: "dirty", paths: blocked.value });

  const args = ["cherry-pick", "--end-of-options", sha];
  const picked = await runGit(repo, args);
  if (picked.ok) return gitValue(repo, ["rev-parse", "--verify", "HEAD"]);
  const stopped = await runGit(repo, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  return stopped.ok ? abortStoppedPick(repo, args, picked) : err(gitError(repo, args, picked));
}
