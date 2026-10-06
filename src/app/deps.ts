import type { LimiterConfig } from "../domain/limiter.ts";
import type { PromptLimits } from "../domain/prompt.ts";
import type { Result } from "../domain/result.ts";
import type {
  Clock,
  GateRunner,
  Git,
  Ids,
  JobStore,
  LimiterStore,
  Output,
  ProcessControl,
  Semaphore,
  Worker,
  WorkerError,
} from "../ports/index.ts";

/** Facts about the host that only `setup` and `brief new` need. */
export interface HostInfo {
  /** Absolute state root (jobs, worktrees, slots, briefs). */
  readonly stateRoot: string;
  readonly claudeBin: string;
  claudeVersion(): Promise<Result<string, string>>;
  /** Where the Z.ai key would come from (`ZAI_API_KEY` or the key file path); never the key itself. */
  keySource(): Promise<Result<string, WorkerError>>;
}

/** Everything a use case may touch. Built once in cli/main.ts from adapters; tests build it from test/support fakes. */
export interface Deps {
  readonly worker: Worker;
  readonly git: Git;
  readonly gates: GateRunner;
  readonly store: JobStore;
  readonly semaphore: Semaphore;
  readonly limiter: LimiterStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly process: ProcessControl;
  readonly out: Output;
  readonly host: HostInfo;
  /** The orchestrator's environment, read only for brief `env` names. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: {
    readonly limiter: LimiterConfig;
    readonly prompt: PromptLimits;
    readonly stopGraceMs: number;
  };
}
