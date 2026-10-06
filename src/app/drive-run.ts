import type { Attempt, Job, WorkerOutcome } from "../domain/job.ts";
import { MODELS } from "../domain/model.ts";
import { selfContainedPrompt } from "../domain/prompt.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  finalizeWorker,
  INITIAL_PROGRESS,
  type Progress,
  reduceProgress,
  type StreamEvent,
  type WorkerResult,
} from "../domain/stream.ts";
import type { WorkerError, WorkerRun, WorkerSpec } from "../ports/index.ts";
import { resumesSession } from "./attempts.ts";
import type { Deps } from "./deps.ts";
import { type AppError, describeWorkerError } from "./errors.ts";
import { writeProgress } from "./job-files.ts";
import { reportSchema } from "./report-schema.ts";
import type { StopWatch } from "./stop-watch.ts";

/** Progress reaches progress.json at most this often while the worker streams. */
const PROGRESS_EVERY_MS = 2_000;
const RATE_LIMITED = 429;
/** What Claude Code prints when `--resume` names a session it does not have. */
const NO_SUCH_SESSION = /no conversation found/i;

export interface AttemptRun {
  /** The attempt as it ran: outcome, usage, report, endedAt, and the session/prompt actually used. */
  readonly attempt: Attempt;
  readonly outcome: WorkerOutcome;
  /** Set when the worker could not be started at all (retrying will not help). */
  readonly failure?: AppError;
}

/** Runs the worker for `attempt`. A fix attempt whose session cannot be resumed is re-run once in a new session with
 *  the prompt made self-contained. */
export async function runAttempt(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  stop: StopWatch,
): Promise<AttemptRun> {
  const schema = await reportSchema(job.brief.report);
  if (!schema.ok) {
    return notStarted(deps, attempt, schema.error, {
      kind: "brief",
      errors: [{ kind: "field", field: "report", message: schema.error }],
    });
  }
  const resume = resumesSession(attempt);
  const first = await runSession(deps, job, attempt, schema.value, stop, resume);
  if (!(resume && sessionMissing(first))) return finished(deps, attempt, first);
  const fresh: Attempt = {
    ...attempt,
    prompt: selfContainedPrompt(
      job.brief,
      job.attempts.slice(0, attempt.n - 1),
      attempt.prompt,
      job.workspace.artifactsDir,
    ),
    sessionId: deps.ids.sessionId(),
  };
  return finished(deps, fresh, await runSession(deps, job, fresh, schema.value, stop, false));
}

function sessionMissing(run: Result<WorkerResult, WorkerError>): boolean {
  return run.ok && run.value.outcome.kind === "crashed" && NO_SUCH_SESSION.test(run.value.outcome.stderrTail);
}

function finished(deps: Deps, attempt: Attempt, run: Result<WorkerResult, WorkerError>): AttemptRun {
  if (!run.ok)
    return notStarted(deps, attempt, describeWorkerError(run.error), { kind: "worker", error: run.error });
  const { outcome, usage, report, sessionId } = run.value;
  return {
    attempt: {
      ...attempt,
      sessionId: sessionId ?? attempt.sessionId,
      endedAt: deps.clock.iso(),
      outcome,
      usage,
      report,
    },
    outcome,
  };
}

function notStarted(deps: Deps, attempt: Attempt, message: string, failure: AppError): AttemptRun {
  const outcome: WorkerOutcome = { kind: "crashed", exitCode: null, signal: null, stderrTail: message };
  return { attempt: { ...attempt, endedAt: deps.clock.iso(), outcome }, outcome, failure };
}

async function runSession(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  jsonSchema: Record<string, unknown>,
  stop: StopWatch,
  resume: boolean,
): Promise<Result<WorkerResult, WorkerError>> {
  const started = await deps.worker.start(workerSpec(deps, job, attempt, jsonSchema, resume));
  if (!started.ok) return err(started.error);
  const run = started.value;
  // The worker has no stop API: a stop terminates its process group, which comes back as a plain SIGTERM exit.
  const requested = { stop: false };
  const terminate = () => {
    requested.stop = true;
    void deps.process.terminateGroup(run.pid, deps.config.stopGraceMs);
  };
  if (stop.signal.aborted) terminate();
  else stop.signal.addEventListener("abort", terminate, { once: true });
  try {
    const kept = await follow(deps, job, attempt.n, run);
    const exit = await run.exit;
    return ok(finalizeWorker(kept, exit, requested.stop ? "stopped" : exit.forced));
  } finally {
    stop.signal.removeEventListener("abort", terminate);
  }
}

/** Folds the stream into progress (persisted at most every 2 s, and once at the end), reports every 429 retry to the
 *  limiter, and keeps only the events finalizeWorker reads (a long run streams many thousands of deltas). */
async function follow(deps: Deps, job: Job, n: number, run: WorkerRun): Promise<readonly StreamEvent[]> {
  const paths = deps.store.paths(job.id);
  const kept: StreamEvent[] = [];
  let progress: Progress = INITIAL_PROGRESS;
  let savedAt = Number.NEGATIVE_INFINITY;
  for await (const event of run.events) {
    progress = reduceProgress(progress, event);
    if (event.type === "init" || event.type === "api_retry" || event.type === "result") kept.push(event);
    if (event.type === "api_retry" && event.status === RATE_LIMITED)
      await deps.limiter.rateLimited(deps.clock.now());
    if (deps.clock.now() - savedAt >= PROGRESS_EVERY_MS) {
      savedAt = deps.clock.now();
      await writeProgress(paths, n, progress);
    }
  }
  await writeProgress(paths, n, progress);
  return kept;
}

function workerSpec(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  jsonSchema: Record<string, unknown>,
  resume: boolean,
): WorkerSpec {
  const { brief, workspace } = job;
  return {
    cwd: workspaceDir(job),
    model: MODELS[brief.model],
    ...(brief.effort === undefined ? {} : { effort: brief.effort }),
    permissionMode: brief.mode === "readonly" ? "plan" : "bypassPermissions",
    prompt: attempt.prompt,
    session: { kind: resume ? "resume" : "new", id: attempt.sessionId },
    jsonSchema,
    // exec writes its outputs to the artifacts dir, outside the repository it runs in.
    addDirs: brief.mode === "exec" ? [...brief.addDirs, workspace.artifactsDir] : brief.addDirs,
    ...(brief.budgetUsd === undefined ? {} : { budgetUsd: brief.budgetUsd }),
    passEnv: passEnv(deps, job),
    timeoutMs: brief.timeoutMs,
    logPath: deps.store.paths(job.id).attemptLog(attempt.n),
  };
}

/** Where the worker and the gates run: the job's worktree (edit) or the repository itself. */
export function workspaceDir(job: Job): string {
  return job.workspace.worktree ?? job.workspace.repoRoot;
}

/** The brief's env names with their values from the orchestrator's environment (never persisted), plus ZAI_ARTIFACTS. */
export function passEnv(deps: Deps, job: Job): Readonly<Record<string, string>> {
  const named = job.brief.env.flatMap((name) => {
    const value = deps.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(named), ZAI_ARTIFACTS: job.workspace.artifactsDir };
}
