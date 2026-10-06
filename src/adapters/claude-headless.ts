import { ALIAS_ENV } from "../domain/model.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseStreamLine, type StreamEvent } from "../domain/stream.ts";
import type { Worker, WorkerError, WorkerRun, WorkerSpec } from "../ports/index.ts";
import { startStreaming } from "./proc-stream.ts";

export const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

/** Variables copied from the parent environment. Everything else (the orchestrator's ANTHROPIC_*, CLAUDE_*, plugin
 *  variables, tokens) is dropped. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "USER",
  "LOGNAME",
] as const;

/** Claude Code gets this long after SIGTERM to stop its tools before the group is killed. */
const KILL_GRACE_MS = 5_000;

/** argv for `claude` (prompt goes to stdin, never argv). */
export function buildClaudeArgs(spec: WorkerSpec): readonly string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    spec.model.alias,
    spec.session.kind === "new" ? "--session-id" : "--resume",
    spec.session.id,
    "--permission-mode",
    spec.permissionMode,
    "--json-schema",
    JSON.stringify(spec.jsonSchema),
    ...(spec.effort === undefined ? [] : ["--effort", spec.effort]),
    ...(spec.budgetUsd === undefined ? [] : ["--max-budget-usd", String(spec.budgetUsd)]),
    // Last: `--add-dir` is variadic in Claude Code, so nothing that follows may be mistaken for another directory.
    ...spec.addDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

/** Allowlisted parent env + spec.passEnv + Z.ai routing + alias mapping + isolated CLAUDE_CONFIG_DIR + the key. */
export function buildWorkerEnv(
  spec: WorkerSpec,
  key: string,
  parent: Readonly<Record<string, string | undefined>>,
  configDir: string,
): Record<string, string> {
  return {
    ...pickAllowlisted(parent),
    ...withoutReservedNames(spec.passEnv),
    ANTHROPIC_BASE_URL: ZAI_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ...ALIAS_ENV,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: configDir,
  };
}

function pickAllowlisted(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Brief `env` names are orchestrator-written, so a typo like `env: [ANTHROPIC_API_KEY]` must not be able to send the
 *  orchestrator's Anthropic credentials to Z.ai, nor re-route or re-configure the worker. */
function isReservedName(name: string): boolean {
  return (
    name.startsWith("ANTHROPIC_") ||
    name.startsWith("CLAUDE") ||
    name === "API_TIMEOUT_MS" ||
    name === "ZAI_API_KEY"
  );
}

function withoutReservedNames(passEnv: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(passEnv).filter(([name]) => !isReservedName(name)));
}

export interface ClaudeHeadlessOptions {
  /** `claude` by default; tests point it at test/support/fake-claude.ts. */
  readonly bin: string;
  readonly configDir: string;
  readonly loadKey: () => Promise<Result<string, WorkerError>>;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** stream-json line parser; domain/stream.ts parseStreamLine by default. Injectable so the process plumbing can be
   *  tested on its own. */
  readonly parse?: (line: string) => Result<readonly StreamEvent[], string>;
}

/** Spawns detached (own process group), writes the prompt to stdin, tees stdout to spec.logPath, yields parsed events,
 *  enforces spec.timeoutMs by terminating the group. */
export class ClaudeHeadlessWorker implements Worker {
  // A plain field, not a parameter property: Node runs src/ with type stripping, which only erases syntax.
  private readonly options: ClaudeHeadlessOptions;

  constructor(options: ClaudeHeadlessOptions) {
    this.options = options;
  }

  async start(spec: WorkerSpec): Promise<Result<WorkerRun, WorkerError>> {
    const key = await this.options.loadKey();
    if (!key.ok) return key;
    const child = await startStreaming({
      command: this.options.bin,
      args: buildClaudeArgs(spec),
      cwd: spec.cwd,
      env: buildWorkerEnv(spec, key.value, this.options.parentEnv, this.options.configDir),
      stdin: spec.prompt,
      logPath: spec.logPath,
      timeoutMs: spec.timeoutMs,
      graceMs: KILL_GRACE_MS,
    });
    if (!child.ok) return err({ kind: "spawn_failed", message: child.error });
    const { pid, lines, exit } = child.value;
    return ok({ pid, events: parsed(lines, this.options.parse ?? parseStreamLine), exit });
  }
}

/** Lines the parser rejects are skipped: they stay in the raw log, and one bad line must not end the stream. */
async function* parsed(
  lines: AsyncIterable<string>,
  parse: (line: string) => Result<readonly StreamEvent[], string>,
): AsyncGenerator<StreamEvent> {
  for await (const line of lines) {
    const events = parse(line);
    if (events.ok) yield* events.value;
  }
}
