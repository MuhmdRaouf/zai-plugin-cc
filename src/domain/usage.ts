import type { Job } from "./job.ts";
import type { ModelTier } from "./model.ts";

/**
 * The GLM quality ledger the orchestrator reports. Per model tier, over decided jobs (accepted|discarded) unless noted:
 * - jobs: all jobs; decided; accepted; discarded
 * - firstTryPassRate: share of decided jobs whose FIRST attempt verdict was pass
 * - acceptRate: accepted / decided
 * - meanAttemptsToAccept: mean attempts over accepted jobs
 * - reviewReturns: total review_fix attempts
 * - tokens/cost/rateLimitRetries/durationMs: sums over all attempts of all jobs
 * Rates are null when the denominator is 0.
 */
export interface TierUsage {
  readonly tier: ModelTier;
  readonly jobs: number;
  readonly decided: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly firstTryPassRate: number | null;
  readonly acceptRate: number | null;
  readonly meanAttemptsToAccept: number | null;
  readonly reviewReturns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly rateLimitRetries: number;
  readonly durationMs: number;
}

const TIER_ORDER: readonly ModelTier[] = ["glm", "flash"];

export function summarizeUsage(jobs: readonly Job[]): readonly TierUsage[] {
  return TIER_ORDER.flatMap((tier) => {
    const tierJobs = jobs.filter((job) => job.brief.model === tier);
    return tierJobs.length === 0 ? [] : [tierUsage(tier, tierJobs)];
  });
}

function tierUsage(tier: ModelTier, jobs: readonly Job[]): TierUsage {
  const accepted = jobs.filter((job) => job.state === "accepted");
  const discarded = jobs.filter((job) => job.state === "discarded");
  const decided = [...accepted, ...discarded];
  const passedFirstTry = decided.filter((job) => job.attempts[0]?.verdict === "pass");
  const attempts = jobs.flatMap((job) => job.attempts);
  const usages = attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]));
  return {
    tier,
    jobs: jobs.length,
    decided: decided.length,
    accepted: accepted.length,
    discarded: discarded.length,
    firstTryPassRate: ratio(passedFirstTry.length, decided.length),
    acceptRate: ratio(accepted.length, decided.length),
    meanAttemptsToAccept: ratio(
      sum(accepted, (job) => job.attempts.length),
      accepted.length,
    ),
    reviewReturns: attempts.filter((attempt) => attempt.kind === "review_fix").length,
    inputTokens: sum(usages, (usage) => usage.inputTokens),
    outputTokens: sum(usages, (usage) => usage.outputTokens),
    cacheReadTokens: sum(usages, (usage) => usage.cacheReadTokens),
    costUsd: sum(usages, (usage) => usage.costUsd),
    rateLimitRetries: sum(usages, (usage) => usage.rateLimitRetries),
    durationMs: sum(usages, (usage) => usage.durationMs),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
