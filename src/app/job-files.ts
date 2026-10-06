/**
 * Sidecar files in a job's directory, next to job.json: the stop request, the driver's progress snapshot (written
 * often, so it stays out of job.json) and the driver lock the store maintains (read here only to tell live drivers from
 * dead ones).
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { INITIAL_PROGRESS, type Progress, parseStreamLine, reduceProgress } from "../domain/stream.ts";
import type { JobPaths } from "../ports/index.ts";

const STOP = "stop";
const PROGRESS = "progress.json";
/** Written by the store's lock(); see adapters/fs-store.ts for the layout. */
const DRIVER_LOCK = "driver.lock";

export async function requestStop(paths: JobPaths): Promise<void> {
  await writeFile(join(paths.dir, STOP), "");
}

export async function stopRequested(paths: JobPaths): Promise<boolean> {
  return readFile(join(paths.dir, STOP)).then(
    () => true,
    () => false,
  );
}

export async function clearStop(paths: JobPaths): Promise<void> {
  await rm(join(paths.dir, STOP), { force: true });
}

const ProgressSchema = z.object({
  sessionId: z.string().optional(),
  phase: z.enum(["starting", "thinking", "tool", "writing", "rate_limited", "done"]),
  turns: z.number(),
  lastTool: z.string().optional(),
  lastText: z.string(),
  rateLimitRetries: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
});

const Snapshot = z.object({ attempt: z.number(), progress: ProgressSchema });

export async function writeProgress(paths: JobPaths, attempt: number, progress: Progress): Promise<void> {
  await writeFile(join(paths.dir, PROGRESS), `${JSON.stringify({ attempt, progress })}\n`);
}

/** The driver's latest snapshot for `attempt`; undefined when there is none (or it belongs to another attempt). */
export async function readProgress(paths: JobPaths, attempt: number): Promise<Progress | undefined> {
  const text = await readFile(join(paths.dir, PROGRESS), "utf8").catch(() => "");
  const snapshot = Snapshot.safeParse(parseJson(text));
  if (!snapshot.success || snapshot.data.attempt !== attempt) return undefined;
  const { sessionId, lastTool, ...rest } = snapshot.data.progress;
  return {
    ...rest,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
}

/** Progress folded from an attempt's raw stream log; undefined when the log does not exist yet. */
export async function foldAttemptLog(path: string): Promise<Progress | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return text.split("\n").reduce((progress, line) => {
    const parsed = parseStreamLine(line);
    return parsed.ok ? parsed.value.reduce(reduceProgress, progress) : progress;
  }, INITIAL_PROGRESS);
}

/** The pid in the driver lock file, if one is held. */
export async function driverPid(paths: JobPaths): Promise<number | undefined> {
  const text = await readFile(join(paths.dir, DRIVER_LOCK), "utf8").catch(() => "");
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
