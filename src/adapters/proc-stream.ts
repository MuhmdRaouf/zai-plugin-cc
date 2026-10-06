import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { err, ok, type Result } from "../domain/result.ts";
import type { WorkerExit } from "../ports/index.ts";
import { terminateGroup } from "./proc-group.ts";
import { createLineQueue } from "./proc-queue.ts";

/** Keeps the end of stderr, where crash reasons are. */
const STDERR_TAIL_CHARS = 4_000;
/** setTimeout turns larger delays into 1 ms, which would time a worker out at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface StreamingCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  /** Raw stdout is appended here, byte for byte. */
  readonly logPath: string;
  /** After this the whole group is terminated and the exit reports forced "timeout". */
  readonly timeoutMs: number;
  /** Between SIGTERM and SIGKILL. */
  readonly graceMs: number;
}

export interface StreamingProcess {
  readonly pid: number;
  /** stdout split into lines (without the newline). */
  readonly lines: AsyncIterable<string>;
  readonly exit: Promise<WorkerExit>;
}

/** Starts `command` in its own process group and streams its stdout line by line. */
export async function startStreaming(cmd: StreamingCommand): Promise<Result<StreamingProcess, string>> {
  const log = await openLog(cmd.logPath);
  if (!log.ok) return log;
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: "pipe" });
  // A child that exits without reading its input makes the write fail with EPIPE; its exit tells the real story.
  child.stdin.on("error", () => {});
  const pid = await spawned(child);
  if (!pid.ok) {
    await new Promise<void>((resolve) => log.value.end(resolve));
    return pid;
  }
  child.stdin.end(cmd.stdin);
  return ok({
    pid: pid.value,
    lines: splitLines(child, log.value),
    exit: supervise(child, pid.value, cmd, log.value),
  });
}

/** Spawn errors (missing binary, bad cwd) arrive as an async "error" event instead of a "spawn" event. Once "spawn"
 *  fired the pid is set; the -1 only satisfies the type and is refused by every signalling helper. */
function spawned(child: ChildProcessWithoutNullStreams): Promise<Result<number, string>> {
  return new Promise((resolve) => {
    child.once("spawn", () => resolve(ok(child.pid ?? -1)));
    child.once("error", (error) => resolve(err(error.message)));
  });
}

async function openLog(path: string): Promise<Result<WriteStream, string>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    return ok(handle.createWriteStream());
  } catch (error) {
    return err(`cannot open log ${path}: ${String(error)}`);
  }
}

function splitLines(child: ChildProcessWithoutNullStreams, log: WriteStream): AsyncIterable<string> {
  const queue = createLineQueue();
  const decoder = new StringDecoder("utf8");
  let partial = "";
  child.stdout.on("data", (chunk: Buffer) => {
    log.write(chunk);
    const parts = (partial + decoder.write(chunk)).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) queue.push(line);
  });
  child.stdout.on("end", () => {
    const rest = partial + decoder.end();
    if (rest !== "") queue.push(rest);
    queue.close();
  });
  return queue.lines;
}

function supervise(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  cmd: StreamingCommand,
  log: WriteStream,
): Promise<WorkerExit> {
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    termination ??= terminateGroup(pid, cmd.graceMs);
    return termination;
  };
  let forced: WorkerExit["forced"] = null;
  const timer = setTimeout(
    () => {
      forced = "timeout";
      void terminate();
    },
    Math.min(cmd.timeoutMs, MAX_TIMER_MS),
  );
  // Background processes the worker started would outlive it and hold stdout open: the group goes with its leader.
  child.once("exit", () => void terminate());
  const stderr = tailOf(child);
  return new Promise((resolve) => {
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      await terminate();
      // Resolve only once the log is flushed and closed, so readers of a finished attempt see all of it.
      log.end(() => resolve({ code, signal, stderrTail: stderr(), forced }));
    });
  });
}

function tailOf(child: ChildProcessWithoutNullStreams): () => string {
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  return () => tail;
}
