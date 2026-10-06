import { mkdir, writeFile } from "node:fs/promises";
import { type Brief, parseBrief } from "../domain/brief.ts";
import type { Job, Workspace } from "../domain/job.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";
import { reportSchema } from "./report-schema.ts";
import { withOverrides } from "./submit-overrides.ts";

export interface SubmitInput {
  /** Brief document text and where it came from (for relative cwd/addDirs/report paths). */
  readonly text: string;
  readonly sourcePath?: string;
  readonly cwd: string;
  /** CLI overrides: --flash, --mode, --effort. Applied after parsing, before defaults that depend on them. */
  readonly overrides?: { readonly model?: "glm" | "flash"; readonly mode?: "edit" | "exec" | "readonly" };
}

/**
 * Parse + validate the brief, check every `env` name is set in deps.env (values are not stored), resolve repo root and
 * base sha, create the artifacts dir and (edit mode) the worktree on branch zai/<id>, persist the job as `queued`.
 * Any failure after the worktree exists removes it again (no orphans).
 */
export async function submit(deps: Deps, input: SubmitInput): Promise<Result<Job, AppError>> {
  const brief = await validBrief(deps, input);
  if (!brief.ok) return brief;
  const repoRoot = await deps.git.root(brief.value.cwd);
  if (!repoRoot.ok) return err({ kind: "git", error: repoRoot.error });
  const baseSha = await deps.git.resolve(repoRoot.value, brief.value.base);
  if (!baseSha.ok) return err({ kind: "git", error: baseSha.error });

  const id = deps.ids.jobId();
  const paths = deps.store.paths(id);
  const workspace: Workspace = {
    repoRoot: repoRoot.value,
    baseSha: baseSha.value,
    ...(brief.value.mode === "edit" ? { worktree: paths.worktree, branch: `zai/${id}` } : {}),
    artifactsDir: paths.artifacts,
  };
  if (workspace.worktree !== undefined && workspace.branch !== undefined) {
    const added = await deps.git.addWorktree(
      workspace.repoRoot,
      workspace.worktree,
      workspace.branch,
      baseSha.value,
    );
    if (!added.ok) return err({ kind: "git", error: added.error });
  }
  const now = deps.clock.iso();
  const job: Job = {
    id,
    brief: brief.value,
    state: "queued",
    workspace,
    attempts: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
  const created = await deps.store.create(job);
  if (!created.ok) {
    if (workspace.worktree !== undefined && workspace.branch !== undefined) {
      await deps.git.removeWorktree(workspace.repoRoot, workspace.worktree, workspace.branch);
    }
    return err({ kind: "store", error: created.error });
  }
  await mkdir(paths.artifacts, { recursive: true });
  await writeFile(paths.brief, input.text);
  return created;
}

/** The brief as the job will run it: parsed against the current git root, overrides applied, report schema file
 *  readable, every env name set. `zai brief lint` checks exactly this. */
export async function validBrief(deps: Deps, input: SubmitInput): Promise<Result<Brief, AppError>> {
  const root = await deps.git.root(input.cwd);
  const defaultCwd = root.ok ? root.value : input.cwd;
  const parsed = parseBrief(withOverrides(input.text, input.overrides ?? {}), { defaultCwd });
  if (!parsed.ok) return err({ kind: "brief", errors: parsed.error });
  const schema = await reportSchema(parsed.value.report);
  if (!schema.ok)
    return err({ kind: "brief", errors: [{ kind: "field", field: "report", message: schema.error }] });
  const missing = parsed.value.env.filter((name) => deps.env[name] === undefined);
  return missing.length > 0 ? err({ kind: "missing_env", names: missing }) : ok(parsed.value);
}
