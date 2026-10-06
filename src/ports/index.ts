/**
 * Ports: the only way app/ touches the world. Adapters implement them; tests use the fakes in test/support/.
 * Expected failures are Result values; adapters never decide policy.
 */
import type { Effort } from "../domain/brief.ts";
import type { ChangeSet, GateResult, Job } from "../domain/job.ts";
import type { ModelSpec } from "../domain/model.ts";
import type { Result } from "../domain/result.ts";
import type { StreamEvent } from "../domain/stream.ts";

// ── worker ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WorkerSpec {
  readonly cwd: string;
  readonly model: ModelSpec;
  readonly effort?: Effort;
  readonly permissionMode: "bypassPermissions" | "plan";
  readonly prompt: string;
  /** New session id (fresh attempt) or the session to resume. */
  readonly session:
    | { readonly kind: "new"; readonly id: string }
    | { readonly kind: "resume"; readonly id: string };
  readonly jsonSchema: Record<string, unknown>;
  readonly addDirs: readonly string[];
  readonly budgetUsd?: number;
  /** Extra environment for the worker: values already resolved from the brief's `env` names. */
  readonly passEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Raw NDJSON is appended here (one file per attempt). */
  readonly logPath: string;
}

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
  readonly forced: "timeout" | "stopped" | null;
}

export interface WorkerRun {
  readonly pid: number;
  readonly events: AsyncIterable<StreamEvent>;
  readonly exit: Promise<WorkerExit>;
}

export type WorkerError =
  | { readonly kind: "no_key"; readonly message: string }
  | { readonly kind: "insecure_key_file"; readonly path: string; readonly mode: string }
  | { readonly kind: "spawn_failed"; readonly message: string };

export interface Worker {
  start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>>;
}

// ── git ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type GitError =
  | { readonly kind: "not_a_repo"; readonly path: string }
  | { readonly kind: "bad_ref"; readonly ref: string }
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  | { readonly kind: "dirty"; readonly paths: readonly string[] }
  | { readonly kind: "git_failed"; readonly command: string; readonly stderr: string };

export interface Git {
  root(cwd: string): Promise<Result<string, GitError>>;
  resolve(repo: string, ref: string): Promise<Result<string, GitError>>;
  currentBranch(repo: string): Promise<Result<string, GitError>>;
  addWorktree(repo: string, path: string, branch: string, baseSha: string): Promise<Result<void, GitError>>;
  removeWorktree(repo: string, path: string, branch: string): Promise<Result<void, GitError>>;
  /** Changes in `dir` relative to baseSha, including untracked files (renames as delete+add). */
  changes(dir: string, baseSha: string): Promise<Result<ChangeSet, GitError>>;
  /** `git status --porcelain=v1 -z` fingerprint, for exec/readonly unchanged checks. */
  statusFingerprint(dir: string): Promise<Result<string, GitError>>;
  diff(dir: string, baseSha: string, opts: { readonly stat: boolean }): Promise<Result<string, GitError>>;
  /** Stage everything in the worktree and commit on its branch. Returns the commit sha. The repository's commit hooks
   *  run unless verify is false; a failing hook is git_failed carrying the hook's output. */
  commitAll(
    dir: string,
    message: string,
    opts: { readonly verify: boolean },
  ): Promise<Result<string, GitError>>;
  /** Cherry-pick a commit onto repo's current branch; aborts cleanly on conflict. */
  cherryPick(repo: string, sha: string): Promise<Result<string, GitError>>;
  /** Apply the worktree's change set to repo's working tree without committing (3-way). */
  applyToWorkingTree(repo: string, worktree: string, baseSha: string): Promise<Result<void, GitError>>;
}

// ── gates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface GateRunner {
  /** Runs `sh -c <run>` in cwd with a minimal env (+ passEnv), bounded output tail, kill on timeout. */
  run(
    cwd: string,
    gate: { readonly run: string; readonly timeoutMs: number },
    passEnv: Readonly<Record<string, string>>,
    logPath: string,
  ): Promise<GateResult>;
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type StoreError =
  | { readonly kind: "not_found"; readonly id: string }
  | {
      readonly kind: "version_conflict";
      readonly id: string;
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly kind: "locked"; readonly id: string; readonly holderPid: number }
  | { readonly kind: "io"; readonly message: string };

export interface JobStore {
  create(job: Job): Promise<Result<Job, StoreError>>;
  get(id: string): Promise<Result<Job, StoreError>>;
  /** Resolves a unique id prefix too. */
  find(idOrPrefix: string): Promise<Result<Job, StoreError>>;
  /** Writes only if stored version === job.version; returns the job with version + 1. */
  update(job: Job): Promise<Result<Job, StoreError>>;
  list(filter?: { readonly repoRoot?: string }): Promise<readonly Job[]>;
  paths(id: string): JobPaths;
  /** Exclusive driver lock (atomic create, stale-pid reclaim). */
  lock(id: string, pid: number): Promise<Result<() => Promise<void>, StoreError>>;
}

export interface JobPaths {
  readonly dir: string;
  readonly brief: string;
  readonly artifacts: string;
  attemptLog(n: number): string;
  gateLog(n: number, gate: number): string;
  readonly worktree: string;
}

export interface Semaphore {
  /** Waits until fewer than capacity() slots are held; returns a release function. */
  acquire(
    holder: { readonly jobId: string; readonly pid: number },
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>;
  held(): Promise<readonly { readonly jobId: string; readonly pid: number }[]>;
}

/** Shared AIMD state (file-backed, locked read-modify-write). */
export interface LimiterStore {
  capacity(now: number): Promise<number>;
  rateLimited(now: number): Promise<void>;
}

// ── small things ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Clock {
  now(): number;
  iso(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Ids {
  jobId(): string;
  sessionId(): string;
}

export interface ProcessControl {
  isAlive(pid: number): boolean;
  /** SIGTERM the process group, SIGKILL after graceMs. */
  terminateGroup(pid: number, graceMs: number): Promise<void>;
  /** Start `zai drive <id>` as an orphaned process-group leader (outside the caller's process tree); returns its pid. */
  spawnDriver(jobId: string): number;
}

export interface Output {
  line(text: string): void;
  error(text: string): void;
}
