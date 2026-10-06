import { MODELS } from "../domain/model.ts";
import { builtinJsonSchema } from "../domain/reports.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { finalizeWorker, type StreamEvent, type WorkerResult } from "../domain/stream.ts";
import type { WorkerError } from "../ports/index.ts";
import type { Deps } from "./deps.ts";

const PING_TIMEOUT_MS = 120_000;
const PING_PROMPT =
  'This is a connectivity check. Use no tools. End at once with a notes report whose summary is "pong", with no findings and no open items.';

/** One tiny real request (flash, plan mode, notes report) that proves the key and the route to Z.ai work. */
export async function ping(deps: Deps): Promise<Result<WorkerResult, WorkerError>> {
  const started = await deps.worker.start({
    cwd: deps.host.stateRoot,
    model: MODELS.flash,
    permissionMode: "plan",
    prompt: PING_PROMPT,
    session: { kind: "new", id: deps.ids.sessionId() },
    jsonSchema: builtinJsonSchema("notes"),
    addDirs: [],
    passEnv: {},
    timeoutMs: PING_TIMEOUT_MS,
    logPath: `${deps.host.stateRoot}/setup-ping.jsonl`,
  });
  if (!started.ok) return err(started.error);
  const events: StreamEvent[] = [];
  for await (const event of started.value.events) events.push(event);
  const exit = await started.value.exit;
  return ok(finalizeWorker(events, exit, exit.forced));
}
