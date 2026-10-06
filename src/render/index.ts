import type { BoardRow, ReviewPacket } from "../app/queries.ts";
import type { Job } from "../domain/job.ts";
import type { TierUsage } from "../domain/usage.ts";
import { board, hook } from "./board.ts";
import { modelId } from "./format.ts";
import { jobView } from "./job.ts";
import { review } from "./review.ts";
import { summary } from "./summary.ts";
import { usage } from "./usage.ts";

/** Pure text renderers. Width-stable tables, no colour codes (Claude reads this output), ISO-free relative ages. */
export function renderBoard(rows: readonly BoardRow[], now: number): string {
  return board(rows, now);
}

/** The review packet: header (id, title, model, mode, attempt n of m, verdict), report summary + open items, a gate
 *  table (failing tails inline), scope result, change list, usage line, then the three next actions as exact commands. */
export function renderReview(packet: ReviewPacket): string {
  return review(packet);
}

/** Compact one-screen summary the dispatcher subagent returns (verdict first, then what changed, then next actions). */
export function renderSummary(job: Job): string {
  return summary(job);
}

export function renderUsage(rows: readonly TierUsage[]): string {
  return usage(rows);
}

/** The first line `zai run` prints, before the job runs: the dispatcher reads the id from it. */
export function renderStarted(job: Job): string {
  return `zai job ${job.id} started: ${job.brief.title} (${modelId(job)}, ${job.brief.mode})`;
}

/** The SessionStart hook's line: jobs awaiting review or still running; empty when there are none. */
export function renderHook(rows: readonly BoardRow[]): string {
  return hook(rows);
}

/** `zai show`: one job's state, attempts and live progress. */
export function renderJob(row: BoardRow, now: number): string {
  return jobView(row, now);
}
