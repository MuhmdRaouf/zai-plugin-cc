import { execFile } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ClaudeHeadlessWorker } from "../adapters/claude-headless.ts";
import { createFsLimiter, createFsSemaphore, createFsStore } from "../adapters/fs-store.ts";
import { createGitCli } from "../adapters/git-cli.ts";
import { KEY_FILE, loadKey } from "../adapters/key.ts";
import { isAlive } from "../adapters/proc-group.ts";
import { createShellGates } from "../adapters/shell-gates.ts";
import { createIds, createProcessControl, createSystemClock } from "../adapters/system.ts";
import type { Deps, HostInfo } from "../app/deps.ts";
import { DEFAULT_LIMITER, type LimiterConfig } from "../domain/limiter.ts";
import { DEFAULT_LIMITS } from "../domain/prompt.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Output } from "../ports/index.ts";

const STOP_GRACE_MS = 10_000;
const VERSION_TIMEOUT_MS = 10_000;
const PRIVATE = 0o700;

export interface WireOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This bundle (or src/cli/main.ts), re-run detached as `drive <id>`. */
  readonly bundlePath: string;
  readonly out: Output;
}

/**
 * State root: $ZAI_STATE_DIR, else $CLAUDE_PLUGIN_DATA when it is zai's own data dir (`…/data/zai-<marketplace>`),
 * else $XDG_STATE_HOME/zai or ~/.local/state/zai. Claude Code leaks one plugin's CLAUDE_PLUGIN_DATA into every Bash
 * tool call, so a foreign one must never be used: zai's jobs would land in another plugin's data dir.
 */
export function stateRoot(env: Readonly<Record<string, string | undefined>>): string {
  if (env.ZAI_STATE_DIR) return env.ZAI_STATE_DIR;
  if (env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA).startsWith("zai-"))
    return env.CLAUDE_PLUGIN_DATA;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, "zai");
  return join(env.HOME ?? homedir(), ".local", "state", "zai");
}

/** ZAI_MAX_CONCURRENCY caps the adaptive limit (a positive integer; 8 otherwise). */
export function limiterConfig(env: Readonly<Record<string, string | undefined>>): LimiterConfig {
  const max = Number(env.ZAI_MAX_CONCURRENCY);
  return Number.isInteger(max) && max >= DEFAULT_LIMITER.min ? { ...DEFAULT_LIMITER, max } : DEFAULT_LIMITER;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: PRIVATE });
  chmodSync(path, PRIVATE);
  return path;
}

/** Real adapters over the state root (and its claude-home config dir), both created mode 0700. */
export function wire(options: WireOptions): Deps {
  const { env } = options;
  const root = privateDir(stateRoot(env));
  const configDir = privateDir(join(root, "claude-home"));
  const bin = env.ZAI_CLAUDE_BIN || "claude";
  const key = () => loadKey(env, KEY_FILE);
  const clock = createSystemClock();
  const store = createFsStore(root, isAlive);
  const config = { limiter: limiterConfig(env), prompt: DEFAULT_LIMITS, stopGraceMs: STOP_GRACE_MS };
  const limiter = createFsLimiter(root, config.limiter);
  return {
    worker: new ClaudeHeadlessWorker({ bin, configDir, loadKey: key, parentEnv: env }),
    git: createGitCli(),
    gates: createShellGates(),
    store,
    semaphore: createFsSemaphore(root, () => limiter.capacity(clock.now()), isAlive, clock.sleep),
    limiter,
    clock,
    ids: createIds(),
    process: createProcessControl(options.bundlePath, (id) => join(store.paths(id).dir, "driver.log")),
    out: options.out,
    host: host(root, bin, env, key),
    env,
    config,
  };
}

function host(
  root: string,
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
  key: () => ReturnType<typeof loadKey>,
): HostInfo {
  return {
    stateRoot: root,
    claudeBin: bin,
    claudeVersion: () => version(bin),
    keySource: async () => {
      const loaded = await key();
      if (!loaded.ok) return loaded;
      return ok(env.ZAI_API_KEY?.trim() ? "ZAI_API_KEY" : KEY_FILE);
    },
  };
}

function version(bin: string): Promise<Result<string, string>> {
  return new Promise((done) => {
    execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      done(error === null ? ok(stdout.trim()) : err(error.message.split("\n")[0] ?? error.message));
    });
  });
}
