/**
 * In-memory and scripted stand-ins for every port, plus a Deps builder. Unit tests of app/ and cli/ run on these; the
 * job directories (stop file, progress.json, attempt logs) live under a real temp dir so the app's file sidecars work.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Deps, HostInfo } from "../../src/app/deps.ts";
import type { ChangeSet, GateResult, Job } from "../../src/domain/job.ts";
import { DEFAULT_LIMITER } from "../../src/domain/limiter.ts";
import { DEFAULT_LIMITS } from "../../src/domain/prompt.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import { parseStreamLine, type StreamEvent } from "../../src/domain/stream.ts";
import type {
  Clock,
  GateRunner,
  Git,
  GitError,
  Ids,
  JobPaths,
  JobStore,
  LimiterStore,
  Output,
  ProcessControl,
  Semaphore,
  StoreError,
  Worker,
  WorkerError,
  WorkerExit,
  WorkerRun,
  WorkerSpec,
} from "../../src/ports/index.ts";
import { aChangeSet, aGateResult } from "./builders.ts";
import { tempDir } from "./tmp.ts";

// ── store ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Same layout as the fs store, so the driver lock file and sidecars land where the app looks for them. */
export function jobPathsUnder(root: string, id: string): JobPaths {
  const dir = join(root, "jobs", id);
  return {
    dir,
    brief: join(dir, "brief.md"),
    artifacts: join(dir, "artifacts"),
    attemptLog: (n) => join(dir, `attempt-${n}.jsonl`),
    gateLog: (n, gate) => join(dir, `gate-${n}-${gate}.log`),
    worktree: join(root, "worktrees", id),
  };
}

export class MemoryStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  /** Every successfully stored version, in write order. */
  readonly writes: Job[] = [];
  readonly locks = new Map<string, number>();
  /** Next create fails with this error. */
  failCreate: StoreError | undefined;
  /** Runs before each update (after the version check passes it would write): lets a test race a concurrent writer. */
  beforeUpdate: ((job: Job) => void) | undefined;

  constructor(readonly root: string) {}

  /** Stores a job as-is (test setup), returning the stored copy. */
  put(job: Job): Job {
    mkdirSync(this.paths(job.id).dir, { recursive: true });
    this.jobs.set(job.id, job);
    return job;
  }

  async create(job: Job): Promise<Result<Job, StoreError>> {
    const failure = this.failCreate;
    this.failCreate = undefined;
    if (failure !== undefined) return err(failure);
    if (this.jobs.has(job.id)) return err({ kind: "io", message: `job ${job.id} already exists` });
    return ok(this.store({ ...job, version: job.version + 1 }));
  }

  async get(id: string): Promise<Result<Job, StoreError>> {
    const job = this.jobs.get(id);
    return job === undefined ? err({ kind: "not_found", id }) : ok(job);
  }

  async find(idOrPrefix: string): Promise<Result<Job, StoreError>> {
    if (this.jobs.has(idOrPrefix)) return this.get(idOrPrefix);
    const matches = [...this.jobs.keys()].filter((id) => idOrPrefix !== "" && id.startsWith(idOrPrefix));
    const [only, ...others] = matches;
    return only !== undefined && others.length === 0
      ? this.get(only)
      : err({ kind: "not_found", id: idOrPrefix });
  }

  async update(job: Job): Promise<Result<Job, StoreError>> {
    this.beforeUpdate?.(job);
    const current = this.jobs.get(job.id);
    if (current === undefined) return err({ kind: "not_found", id: job.id });
    if (current.version !== job.version) {
      return err({ kind: "version_conflict", id: job.id, expected: job.version, actual: current.version });
    }
    return ok(this.store({ ...job, version: job.version + 1 }));
  }

  async list(filter?: { readonly repoRoot?: string }): Promise<readonly Job[]> {
    return [...this.jobs.values()]
      .filter((job) => filter?.repoRoot === undefined || job.workspace.repoRoot === filter.repoRoot)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
      );
  }

  paths(id: string): JobPaths {
    return jobPathsUnder(this.root, id);
  }

  async lock(id: string, pid: number): Promise<Result<() => Promise<void>, StoreError>> {
    if (!this.jobs.has(id)) return err({ kind: "not_found", id });
    const holder = this.locks.get(id);
    if (holder !== undefined) return err({ kind: "locked", id, holderPid: holder });
    this.holdLock(id, pid);
    return ok(async () => {
      if (this.locks.get(id) !== pid) return;
      this.locks.delete(id);
      rmSync(join(this.paths(id).dir, "driver.lock"), { force: true });
    });
  }

  /** Simulates another driver holding the lock (its pid in the lock file, like the fs store). */
  holdLock(id: string, pid: number): void {
    this.locks.set(id, pid);
    mkdirSync(this.paths(id).dir, { recursive: true });
    writeFileSync(join(this.paths(id).dir, "driver.lock"), `${pid}\n`);
  }

  /** The states the job went through, in write order (consecutive repeats collapsed). */
  states(id: string): string[] {
    return this.writes
      .filter((job) => job.id === id)
      .map((job) => job.state)
      .filter((state, i, all) => i === 0 || all[i - 1] !== state);
  }

  private store(job: Job): Job {
    mkdirSync(this.paths(job.id).dir, { recursive: true });
    this.jobs.set(job.id, job);
    this.writes.push(job);
    return job;
  }
}

// ── worker ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** stream-json wire lines, shaped like the live stream (see test/fixtures/stream/). */
export const wire = {
  init: (sessionId: string, model = "glm-5.3"): string =>
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }),
  text: (text: string): string =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  tool: (name: string, input: Record<string, unknown>): string =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }),
  retry: (status: number | null, attempt = 1): string =>
    JSON.stringify({ type: "system", subtype: "api_retry", attempt, max_retries: 10, error_status: status }),
  result: (
    fields: { readonly report?: unknown; readonly isError?: boolean; readonly text?: string } = {},
  ): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: fields.isError ?? false,
      result: fields.text ?? "done",
      structured_output: fields.report ?? null,
      num_turns: 2,
      duration_ms: 1500,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    }),
};

export const VALID_CHANGE_REPORT = {
  summary: "Renamed foo to bar",
  files: [{ path: "src/a.ts", why: "rename" }],
  tests_added: [],
  open_items: [],
};

export interface WorkerScript {
  /** Wire lines to stream (each also appended to the attempt log). */
  readonly lines?: readonly string[];
  /** A file under test/fixtures/stream/ streamed instead of `lines`. */
  readonly fixture?: string;
  readonly exit?: Partial<WorkerExit>;
  /** After the lines, keep running until terminateGroup(pid); the exit then reports SIGTERM, forced null. */
  readonly hang?: boolean;
  /** No `init` line first (a run that fails before its session starts). */
  readonly bare?: boolean;
  readonly startError?: WorkerError;
  /** Runs at start, e.g. to edit files the way the real worker would. */
  readonly onStart?: (spec: WorkerSpec) => void;
}

const FIXTURES = new URL("./../fixtures/stream/", import.meta.url);

/** A completed run with a valid change report, its session announced by init. */
export function completes(report: unknown = VALID_CHANGE_REPORT): WorkerScript {
  return { lines: [wire.text("working"), wire.result({ report })] };
}

export class ScriptedWorker implements Worker {
  readonly specs: WorkerSpec[] = [];
  private nextPid = 50_000;
  private readonly running = new Map<number, () => void>();

  constructor(
    private readonly scripts: WorkerScript[],
    private readonly processes: FakeProcess,
  ) {}

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    this.specs.push(spec);
    const script = this.scripts.length > 1 ? this.scripts.shift() : this.scripts[0];
    if (script === undefined) throw new Error("ScriptedWorker: no script left");
    if (script.startError !== undefined) return err(script.startError);
    script.onStart?.(spec);
    const pid = this.nextPid++;
    this.processes.alive.add(pid);
    const terminated = new Promise<void>((resolve) => this.running.set(pid, resolve));
    this.processes.onTerminate.set(pid, () => this.running.get(pid)?.());
    const lines = this.linesOf(script, spec);
    const finished =
      script.hang === true ? terminated.then(() => "terminated" as const) : Promise.resolve("ok" as const);
    const exit = finished.then((how): WorkerExit => {
      this.processes.alive.delete(pid);
      return how === "terminated"
        ? { code: null, signal: "SIGTERM", stderrTail: "", forced: null }
        : { code: 0, signal: null, stderrTail: "", forced: null, ...script.exit };
    });
    return ok({ pid, events: streamOf(lines, spec.logPath, finished), exit });
  }

  private linesOf(script: WorkerScript, spec: WorkerSpec): readonly string[] {
    if (script.fixture !== undefined)
      return readFileSync(new URL(script.fixture, FIXTURES), "utf8").split("\n");
    const init = script.bare === true ? [] : [wire.init(spec.session.id, spec.model.zaiId)];
    return [...init, ...(script.lines ?? [])];
  }
}

async function* streamOf(
  lines: readonly string[],
  logPath: string,
  finished: Promise<unknown>,
): AsyncGenerator<StreamEvent> {
  mkdirSync(dirname(logPath), { recursive: true });
  for (const line of lines) {
    appendFileSync(logPath, `${line}\n`);
    const parsed = parseStreamLine(line);
    if (parsed.ok) yield* parsed.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await finished;
}

// ── git ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const BASE_SHA = "b".repeat(40);
export const COMMIT_SHA = "c".repeat(40);
export const PICKED_SHA = "d".repeat(40);

type GitCall = { readonly method: keyof Git; readonly args: readonly unknown[] };

/** Every method answers from an overridable handler; calls are recorded. Defaults: /repo is the repository. */
export class FakeGit implements Git {
  readonly calls: GitCall[] = [];
  /** Changes reported for a directory (default: none). */
  changeSet: ChangeSet = aChangeSet();
  /** Successive statusFingerprint answers; the last repeats. */
  fingerprints: string[] = ["fp-0"];
  diffText = "diff --git a/src/a.ts b/src/a.ts\n+bar\n";
  diffStat = " src/a.ts | 2 +-\n 1 file changed\n";
  worktreeHead = BASE_SHA;
  commitResult: Result<string, GitError> = ok(COMMIT_SHA);
  pickResult: Result<string, GitError> = ok(PICKED_SHA);
  applyResult: Result<void, GitError> = ok(undefined);
  addWorktreeResult: Result<void, GitError> = ok(undefined);
  removeWorktreeResult: Result<void, GitError> = ok(undefined);

  private record(method: keyof Git, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  called(method: keyof Git): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  async root(cwd: string): Promise<Result<string, GitError>> {
    this.record("root", cwd);
    return cwd === "/repo" || cwd.startsWith("/repo/") ? ok("/repo") : err({ kind: "not_a_repo", path: cwd });
  }
  async resolve(repo: string, ref: string): Promise<Result<string, GitError>> {
    this.record("resolve", repo, ref);
    if (ref === "HEAD" && repo !== "/repo") return ok(this.worktreeHead);
    return ref === "missing" ? err({ kind: "bad_ref", ref }) : ok(BASE_SHA);
  }
  async currentBranch(repo: string): Promise<Result<string, GitError>> {
    this.record("currentBranch", repo);
    return ok("main");
  }
  async addWorktree(
    repo: string,
    path: string,
    branch: string,
    baseSha: string,
  ): Promise<Result<void, GitError>> {
    this.record("addWorktree", repo, path, branch, baseSha);
    return this.addWorktreeResult;
  }
  async removeWorktree(repo: string, path: string, branch: string): Promise<Result<void, GitError>> {
    this.record("removeWorktree", repo, path, branch);
    return this.removeWorktreeResult;
  }
  async changes(dir: string, baseSha: string): Promise<Result<ChangeSet, GitError>> {
    this.record("changes", dir, baseSha);
    return ok(this.changeSet);
  }
  async statusFingerprint(dir: string): Promise<Result<string, GitError>> {
    this.record("statusFingerprint", dir);
    const next = this.fingerprints.length > 1 ? this.fingerprints.shift() : this.fingerprints[0];
    return ok(next ?? "fp-0");
  }
  async diff(
    dir: string,
    baseSha: string,
    opts: { readonly stat: boolean },
  ): Promise<Result<string, GitError>> {
    this.record("diff", dir, baseSha, opts);
    return ok(opts.stat ? this.diffStat : this.diffText);
  }
  async commitAll(
    dir: string,
    message: string,
    opts: { readonly verify: boolean },
  ): Promise<Result<string, GitError>> {
    this.record("commitAll", dir, message, opts);
    if (this.commitResult.ok) this.worktreeHead = this.commitResult.value;
    return this.commitResult;
  }
  async cherryPick(repo: string, sha: string): Promise<Result<string, GitError>> {
    this.record("cherryPick", repo, sha);
    return this.pickResult;
  }
  async applyToWorkingTree(repo: string, worktree: string, baseSha: string): Promise<Result<void, GitError>> {
    this.record("applyToWorkingTree", repo, worktree, baseSha);
    return this.applyResult;
  }
}

// ── gates, limiter, semaphore ─────────────────────────────────────────────────────────────────────────────────────────

export class FakeGates implements GateRunner {
  readonly calls: {
    readonly cwd: string;
    readonly run: string;
    readonly passEnv: Readonly<Record<string, string>>;
    readonly logPath: string;
  }[] = [];
  /** Successive results per gate command; the last repeats. Unlisted commands pass. */
  results = new Map<string, Partial<GateResult>[]>();

  failOnce(run: string, tail = "1 failing test"): void {
    this.results.set(run, [{ exitCode: 1, tail }, { exitCode: 0 }]);
  }

  async run(
    cwd: string,
    gate: { readonly run: string; readonly timeoutMs: number },
    passEnv: Readonly<Record<string, string>>,
    logPath: string,
  ): Promise<GateResult> {
    this.calls.push({ cwd, run: gate.run, passEnv, logPath });
    const queue = this.results.get(gate.run) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return aGateResult({ run: gate.run, durationMs: 10, ...next });
  }
}

export class FakeLimiter implements LimiterStore {
  cap = 4;
  readonly rateLimitedAt: number[] = [];
  async capacity(): Promise<number> {
    return this.cap;
  }
  async rateLimited(now: number): Promise<void> {
    this.rateLimitedAt.push(now);
  }
}

export class FakeSemaphore implements Semaphore {
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  /** When true, acquire waits until its signal aborts. */
  blocked = false;

  async acquire(
    holder: { readonly jobId: string; readonly pid: number },
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    if (this.blocked) {
      await new Promise<void>((_, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.acquired.push(holder.jobId);
    return async () => {
      this.released.push(holder.jobId);
    };
  }
  async held(): Promise<readonly { readonly jobId: string; readonly pid: number }[]> {
    return [];
  }
}

// ── small things ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const T0 = Date.parse("2026-10-06T00:00:00.000Z");

/** Time moves only when someone sleeps (or a test advances it); a sleep still yields to real timers for a moment. */
export class ManualClock implements Clock {
  constructor(public current = T0) {}
  now(): number {
    return this.current;
  }
  iso(): string {
    return new Date(this.current).toISOString();
  }
  advance(ms: number): void {
    this.current += ms;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.current += ms;
    signal?.throwIfAborted();
  }
}

export class FakeIds implements Ids {
  private jobs = 0;
  private sessions = 0;
  jobId(): string {
    this.jobs += 1;
    return `261006-job00${this.jobs}`;
  }
  sessionId(): string {
    this.sessions += 1;
    return `00000000-0000-4000-8000-${String(this.sessions).padStart(12, "0")}`;
  }
}

export class FakeProcess implements ProcessControl {
  readonly alive = new Set<number>([process.pid]);
  readonly terminated: number[] = [];
  readonly spawned: string[] = [];
  readonly onTerminate = new Map<number, () => void>();
  /** Stands in for the detached driver a spawn would start (for example: drive the job with the same deps). */
  onSpawn: ((jobId: string) => void) | undefined;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  async terminateGroup(pid: number): Promise<void> {
    this.terminated.push(pid);
    this.alive.delete(pid);
    this.onTerminate.get(pid)?.();
  }
  spawnDriver(jobId: string): number {
    this.spawned.push(jobId);
    this.onSpawn?.(jobId);
    return 70_000 + this.spawned.length;
  }
}

export class RecordingOutput implements Output {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  line(text: string): void {
    this.lines.push(text);
  }
  error(text: string): void {
    this.errors.push(text);
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

export class FakeHost implements HostInfo {
  claudeBin = "/usr/local/bin/claude";
  version: Result<string, string> = ok("2.1.289 (Claude Code)");
  keyResult: Result<string, WorkerError> = ok("ZAI_API_KEY");
  constructor(readonly stateRoot: string) {}
  async claudeVersion(): Promise<Result<string, string>> {
    return this.version;
  }
  async keySource(): Promise<Result<string, WorkerError>> {
    return this.keyResult;
  }
}

// ── Deps ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Fakes {
  readonly root: string;
  readonly store: MemoryStore;
  readonly git: FakeGit;
  readonly gates: FakeGates;
  readonly worker: ScriptedWorker;
  readonly limiter: FakeLimiter;
  readonly semaphore: FakeSemaphore;
  readonly clock: ManualClock;
  readonly ids: FakeIds;
  readonly process: FakeProcess;
  readonly out: RecordingOutput;
  readonly host: FakeHost;
  readonly deps: Deps;
}

/** A Deps over fresh fakes rooted in a temp dir; the worker plays `scripts` in order (the last one repeats). */
export function fakeDeps(
  scripts: WorkerScript[] = [completes()],
  env: Readonly<Record<string, string | undefined>> = {},
): Fakes {
  const root = tempDir("zai-app-");
  const processes = new FakeProcess();
  const fakes = {
    root,
    store: new MemoryStore(root),
    git: new FakeGit(),
    gates: new FakeGates(),
    worker: new ScriptedWorker(scripts, processes),
    limiter: new FakeLimiter(),
    semaphore: new FakeSemaphore(),
    clock: new ManualClock(),
    ids: new FakeIds(),
    process: processes,
    out: new RecordingOutput(),
    host: new FakeHost(root),
  };
  const deps: Deps = {
    ...fakes,
    env,
    config: { limiter: DEFAULT_LIMITER, prompt: DEFAULT_LIMITS, stopGraceMs: 100 },
  };
  return { ...fakes, deps };
}
