import type { BoardRow } from "../app/queries.ts";
import { age, modelId, plural, progressText, table, verdictOf } from "./format.ts";

function stale(row: BoardRow): boolean {
  return (row.job.state === "running" || row.job.state === "verifying") && !row.live;
}

function stateLabel(row: BoardRow): string {
  if (row.job.state === "awaiting_review") return `review: ${verdictOf(row.job)}`;
  return stale(row) ? `${row.job.state} (stale)` : row.job.state;
}

export function board(rows: readonly BoardRow[], now: number): string {
  if (rows.length === 0)
    return "No zai jobs yet. Start one with /zai:run <brief.md>, or ask for the zai:glm agent.";
  const lines = table([
    ["ID", "STATE", "MODEL", "MODE", "ATT", "AGE", "TITLE"],
    ...rows.map((row) => [
      row.job.id,
      stateLabel(row),
      modelId(row.job),
      row.job.brief.mode,
      String(row.job.attempts.length),
      age(row.job.createdAt, now),
      row.job.brief.title,
    ]),
  ]);
  const [header = "", ...body] = lines;
  const withProgress = body.flatMap((line, i) => {
    const progress = rows[i]?.progress;
    return progress === undefined ? [line] : [line, `  > ${progressText(progress)}`];
  });
  return [header, ...withProgress, ...staleNote(rows)].join("\n");
}

function staleNote(rows: readonly BoardRow[]): readonly string[] {
  const ids = rows.filter(stale).map((row) => row.job.id);
  if (ids.length === 0) return [];
  return [
    "",
    `stale: ${plural(ids.length, "job has", "jobs have")} no live driver (${ids.join(", ")}); /zai:stop <id> moves one to review, /zai:discard <id> drops it.`,
  ];
}

/** SessionStart line: what needs the reviewer, what is still running; empty when nothing does. */
export function hook(rows: readonly BoardRow[]): string {
  const review = rows.filter((row) => row.job.state === "awaiting_review").map((row) => row.job.id);
  const active = rows.filter((row) => ["queued", "running", "verifying"].includes(row.job.state)).length;
  const parts = [
    ...(review.length === 0
      ? []
      : [
          `${plural(review.length, "job awaits", "jobs await")} review (${review.map((id) => `/zai:review ${id}`).join(", ")})`,
        ]),
    ...(active === 0 ? [] : [`${plural(active, "job")} queued or running`]),
  ];
  return parts.length === 0 ? "" : `zai: ${parts.join("; ")}. /zai:board lists them.`;
}
