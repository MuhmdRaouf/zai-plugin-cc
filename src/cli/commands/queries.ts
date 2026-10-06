import type { BoardRow } from "../../app/queries.ts";
import { board, jobRow, reviewPacket, usage } from "../../app/queries.ts";
import type { JobState } from "../../domain/job.ts";
import { progressText } from "../../render/format.ts";
import { renderBoard, renderHook, renderJob, renderReview, renderUsage } from "../../render/index.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { repoOf } from "../scope.ts";

const MAX_DIFF_CHARS = 60_000;
const FOLLOW_POLL_MS = 2000;
const ACTIVE: ReadonlySet<JobState> = new Set<JobState>(["queued", "running", "verifying"]);

export const boardCommand: Command = {
  name: "board",
  synopsis: ["board [--all] [--hook] [--json]"],
  options: { all: { type: "boolean" }, hook: { type: "boolean" } },
  async run(call) {
    if (call.flag("hook")) return hook(call);
    const rows = await board(call.deps, await scope(call));
    if (call.flag("json")) call.json(rows);
    else call.deps.out.line(renderBoard(rows, call.deps.clock.now()));
    return EXIT.ok;
  },
};

async function scope(call: Invocation): Promise<{ readonly repoRoot?: string; readonly all: boolean }> {
  const repoRoot = await repoOf(call.deps, call.cwd);
  return { ...(repoRoot === undefined ? {} : { repoRoot }), all: call.flag("all") };
}

/** The SessionStart hook: one line or nothing, never an error, always exit 0. */
async function hook(call: Invocation): Promise<ExitCode> {
  try {
    const line = renderHook(await board(call.deps, await scope(call)));
    if (line !== "") call.deps.out.line(line);
  } catch {
    // A hook must never disturb the session it starts.
  }
  return EXIT.ok;
}

export const showCommand: Command = {
  name: "show",
  synopsis: ["show <id> [--follow] [--json]"],
  options: { follow: { type: "boolean" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("show needs a job id");
    const found = await jobRow(call.deps, id);
    if (!found.ok) return call.fail(found.error);
    const row = call.flag("follow") ? await follow(call, found.value) : found.value;
    if (call.flag("json")) call.json(row);
    else call.deps.out.line(renderJob(row, call.deps.clock.now()));
    return EXIT.ok;
  },
};

/** One line per change of state or progress while a live driver works the job; returns the settled row. */
async function follow(call: Invocation, first: BoardRow): Promise<BoardRow> {
  let row = first;
  let shown = "";
  while (ACTIVE.has(row.job.state) && row.live) {
    const line =
      row.progress === undefined ? row.job.state : `${row.job.state} · ${progressText(row.progress)}`;
    if (line !== shown && !call.flag("json")) call.deps.out.line(line);
    shown = line;
    await call.deps.clock.sleep(FOLLOW_POLL_MS);
    const next = await jobRow(call.deps, row.job.id);
    if (!next.ok) return row;
    row = next.value;
  }
  return row;
}

export const reviewCommand: Command = {
  name: "review",
  synopsis: ["review <id> [--diff] [--json]"],
  options: { diff: { type: "boolean" } },
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("review needs a job id");
    const packet = await reviewPacket(call.deps, id, {
      diff: call.flag("diff"),
      maxDiffChars: MAX_DIFF_CHARS,
    });
    if (!packet.ok) return call.fail(packet.error);
    if (call.flag("json")) call.json(packet.value);
    else call.deps.out.line(renderReview(packet.value));
    return EXIT.ok;
  },
};

export const usageCommand: Command = {
  name: "usage",
  synopsis: ["usage [--all] [--json]"],
  options: { all: { type: "boolean" } },
  async run(call) {
    const rows = await usage(call.deps, await scope(call));
    if (call.flag("json")) call.json(rows);
    else call.deps.out.line(renderUsage(rows));
    return EXIT.ok;
  },
};
