import { MODELS } from "../domain/model.ts";
import type { TierUsage } from "../domain/usage.ts";
import { count, duration, percent, table, usd } from "./format.ts";

export function usage(rows: readonly TierUsage[]): string {
  if (rows.length === 0) return "No zai jobs yet: nothing to report.";
  return table([
    [
      "MODEL",
      "JOBS",
      "DECIDED",
      "ACCEPTED",
      "DISCARDED",
      "1ST-TRY",
      "ACCEPT",
      "ATT/ACC",
      "RETURNS",
      "IN",
      "OUT",
      "CACHE",
      "COST",
      "429S",
      "TIME",
    ],
    ...rows.map((row) => [
      MODELS[row.tier].zaiId,
      String(row.jobs),
      String(row.decided),
      String(row.accepted),
      String(row.discarded),
      percent(row.firstTryPassRate),
      percent(row.acceptRate),
      row.meanAttemptsToAccept === null ? "n/a" : row.meanAttemptsToAccept.toFixed(1),
      String(row.reviewReturns),
      count(row.inputTokens),
      count(row.outputTokens),
      count(row.cacheReadTokens),
      usd(row.costUsd),
      String(row.rateLimitRetries),
      duration(row.durationMs),
    ]),
  ]).join("\n");
}
