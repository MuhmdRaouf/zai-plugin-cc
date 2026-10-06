import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildWorkerEnv,
  type ClaudeHeadlessOptions,
  ClaudeHeadlessWorker,
  ENV_ALLOWLIST,
} from "../../src/adapters/claude-headless.ts";
import { KEY_FILE, loadKey } from "../../src/adapters/key.ts";
import { isAlive } from "../../src/adapters/proc-group.ts";
import { MODELS } from "../../src/domain/model.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import type { StreamEvent } from "../../src/domain/stream.ts";
import type { WorkerRun, WorkerSpec } from "../../src/ports/index.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    cwd: "/work/repo",
    model: MODELS.glm,
    permissionMode: "bypassPermissions",
    prompt: "Rename foo to bar everywhere.",
    session: { kind: "new", id: SESSION },
    jsonSchema: { type: "object", properties: { summary: { type: "string" } } },
    addDirs: [],
    passEnv: {},
    timeoutMs: 60_000,
    logPath: "/tmp/zai-test/attempt-1.jsonl",
    ...overrides,
  };
}

const KEY = "zai-test-key-0123456789abcdef";
const CONFIG_DIR = "/state/claude-home";

/** A realistic orchestrator environment: allowlisted basics plus everything that must never reach a worker. */
const PARENT_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/dev",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp/dev",
  USER: "dev",
  LOGNAME: "dev",
  ANTHROPIC_API_KEY: "sk-ant-orchestrator-secret",
  ANTHROPIC_AUTH_TOKEN: "orchestrator-oauth-token",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ANTHROPIC_MODEL: "claude-opus",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: "/home/dev/.claude",
  CLAUDE_PLUGIN_ROOT: "/home/dev/.claude/plugins/zai",
  ZAI_API_KEY: KEY,
  ZAI_MAX_CONCURRENCY: "3",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "gh-secret",
};

/** The value following `flag` in argv, or undefined. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildClaudeArgs", () => {
  it("always: -p, --output-format stream-json, --verbose, --include-partial-messages, --model <alias>", () => {
    const glm = buildClaudeArgs(spec());
    const flash = buildClaudeArgs(spec({ model: MODELS.flash }));

    expect(glm.slice(0, 5)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    expect(flagValue(glm, "--model")).toBe("sonnet");
    expect(flagValue(flash, "--model")).toBe("haiku");
  });
  it("new session → --session-id <id>; resume → --resume <id> (never both)", () => {
    const fresh = buildClaudeArgs(spec({ session: { kind: "new", id: SESSION } }));
    const resumed = buildClaudeArgs(spec({ session: { kind: "resume", id: SESSION } }));

    expect(flagValue(fresh, "--session-id")).toBe(SESSION);
    expect(fresh).not.toContain("--resume");
    expect(flagValue(resumed, "--resume")).toBe(SESSION);
    expect(resumed).not.toContain("--session-id");
  });
  it("--permission-mode from spec; --json-schema as compact JSON", () => {
    const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    const bypass = buildClaudeArgs(spec({ jsonSchema: schema }));
    const plan = buildClaudeArgs(spec({ permissionMode: "plan" }));

    expect(flagValue(bypass, "--permission-mode")).toBe("bypassPermissions");
    expect(flagValue(plan, "--permission-mode")).toBe("plan");
    expect(flagValue(bypass, "--json-schema")).toBe(
      '{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}',
    );
  });
  it("--effort only when set; --max-budget-usd only when set; one --add-dir per dir", () => {
    const bare = buildClaudeArgs(spec());
    const full = buildClaudeArgs(spec({ effort: "high", budgetUsd: 2.5, addDirs: ["/docs/a", "/docs/b"] }));

    expect(bare).not.toContain("--effort");
    expect(bare).not.toContain("--max-budget-usd");
    expect(bare).not.toContain("--add-dir");
    expect(flagValue(full, "--effort")).toBe("high");
    expect(flagValue(full, "--max-budget-usd")).toBe("2.5");
    expect(full.slice(-4)).toEqual(["--add-dir", "/docs/a", "--add-dir", "/docs/b"]);
  });
  it("never contains the prompt or any env value", () => {
    const prompt = "PROMPT-MARKER do the work";
    const args = buildClaudeArgs(
      spec({
        prompt,
        passEnv: { NPM_TOKEN: "env-value-marker" },
        effort: "low",
        addDirs: ["/x"],
        budgetUsd: 1,
      }),
    );

    const joined = args.join("\n");
    expect(joined).not.toContain("PROMPT-MARKER");
    expect(joined).not.toContain("env-value-marker");
  });
});

describe("buildWorkerEnv", () => {
  it("copies only ENV_ALLOWLIST names from the parent", () => {
    const env = buildWorkerEnv(spec(), KEY, PARENT_ENV, CONFIG_DIR);

    const withoutLcAll = buildWorkerEnv(spec(), KEY, { ...PARENT_ENV, LC_ALL: undefined }, CONFIG_DIR);

    for (const name of ENV_ALLOWLIST) expect(env[name]).toBe(PARENT_ENV[name]);
    expect(withoutLcAll).not.toHaveProperty("LC_ALL");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("ZAI_MAX_CONCURRENCY");
  });
  it("drops ANTHROPIC_API_KEY, the orchestrator's ANTHROPIC_AUTH_TOKEN, CLAUDE_* and plugin variables", () => {
    const env = buildWorkerEnv(spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_PLUGIN_ROOT");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("ZAI_MAX_CONCURRENCY");
    const values = Object.values(env);
    for (const leaked of [
      "sk-ant-orchestrator-secret",
      "orchestrator-oauth-token",
      "https://api.anthropic.com",
    ]) {
      expect(values).not.toContain(leaked);
    }
    expect(values).not.toContain("/home/dev/.claude");
  });
  it("sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN=<key>, the alias mapping, API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", () => {
    const env = buildWorkerEnv(spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });
  it("sets CLAUDE_CONFIG_DIR to the isolated dir", () => {
    const env = buildWorkerEnv(spec(), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
  });
  it("adds passEnv after the allowlist (passEnv cannot override the Z.ai routing or the key)", () => {
    const passEnv = {
      NPM_TOKEN: "npm-value",
      PATH: "/opt/tools/bin:/usr/bin",
      ANTHROPIC_BASE_URL: "https://evil.example",
      ANTHROPIC_AUTH_TOKEN: "other-token",
      ANTHROPIC_API_KEY: "sk-ant-orchestrator-secret",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet",
      API_TIMEOUT_MS: "1",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      CLAUDECODE: "1",
      ZAI_API_KEY: KEY,
      ZAI_ARTIFACTS: "/state/jobs/x/artifacts",
    };

    const env = buildWorkerEnv(spec({ passEnv }), KEY, PARENT_ENV, CONFIG_DIR);

    expect(env).toEqual({
      PATH: "/opt/tools/bin:/usr/bin",
      HOME: "/home/dev",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/dev",
      USER: "dev",
      LOGNAME: "dev",
      NPM_TOKEN: "npm-value",
      ZAI_ARTIFACTS: "/state/jobs/x/artifacts",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
    });
  });
});

const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");
const FIXTURE_429 = join(import.meta.dirname, "../fixtures/stream/rate-limited-429.jsonl");

/** Stand-in for domain/stream.ts parseStreamLine: just enough to observe the worker's plumbing on its own. Everything
 *  it does not know becomes `other`, like the real parser; a `{"type":"pair"}` line yields two events. */
function stubParse(line: string): Result<readonly StreamEvent[], string> {
  if (line.trim() === "") return ok([]);
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return err("malformed JSON");
  }
  if (!isRecord(event)) return ok([{ type: "other", raw: line }]);
  if (event.type === "pair") {
    return ok([
      { type: "assistant_text", text: "first" },
      { type: "tool_use", name: "Bash", summary: "second" },
    ]);
  }
  if (event.type === "system" && event.subtype === "init") {
    return ok([{ type: "init", sessionId: String(event.session_id), model: String(event.model) }]);
  }
  if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
    const blocks: unknown[] = event.message.content;
    const text = blocks
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("");
    return ok([{ type: "assistant_text", text }]);
  }
  return ok([{ type: "other", raw: line }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function collect(run: WorkerRun): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe("ClaudeHeadlessWorker (integration, fake claude)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zai-worker-"));
  });
  afterEach(async () => {
    killLeftovers();
    await rm(dir, { recursive: true, force: true });
  });

  /** Groups whose pids a test learned, so a failing test cannot leak processes. */
  const groups: number[] = [];

  function killLeftovers(): void {
    for (const pid of groups.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone: the expected case
      }
    }
  }

  /** Waits for the fake to report "<its pid> <grandchild pid>" (FAKE_CLAUDE_PIDFILE). */
  async function groupPids(pidFile: string): Promise<readonly number[]> {
    for (;;) {
      const content = await readFile(pidFile, "utf8").catch(() => "");
      if (content !== "") {
        const pids = content.split(" ").map(Number);
        groups.push(pids[0] ?? -1);
        return pids;
      }
      await delay(20);
    }
  }

  function worker(overrides: Partial<ClaudeHeadlessOptions> = {}): ClaudeHeadlessWorker {
    return new ClaudeHeadlessWorker({
      bin: FAKE_CLAUDE,
      configDir: join(dir, "claude-home"),
      loadKey: async () => ok(KEY),
      parentEnv: { ...PARENT_ENV, PATH: process.env.PATH },
      parse: stubParse,
      ...overrides,
    });
  }

  function fakeSpec(passEnv: Record<string, string>, overrides: Partial<WorkerSpec> = {}): WorkerSpec {
    return spec({ cwd: dir, logPath: join(dir, "logs", "attempt-1.jsonl"), passEnv, ...overrides });
  }

  async function started(result: Result<WorkerRun, unknown>): Promise<WorkerRun> {
    if (!result.ok) throw new Error(`worker did not start: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  it("streams parsed events from the fake and resolves exit with code 0", async () => {
    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" })));

    const events = await collect(run);
    const exit = await run.exit;

    expect(run.pid).toBeGreaterThan(0);
    expect(events.slice(0, 2)).toEqual([
      { type: "init", sessionId: SESSION, model: "glm-5.3" },
      { type: "assistant_text", text: "done" },
    ]);
    expect(events[2]).toMatchObject({ type: "other", raw: expect.stringContaining('"type":"result"') });
    expect(events).toHaveLength(3);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
  });
  it("writes the prompt to the child's stdin (fake echoes it into an assistant event)", async () => {
    const prompt = 'Rename `foo` → `bar`.\n\n- keep "quotes" and $VARS literal\n- ünïcødé ✓\n';

    const run = await started(
      await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "echo-prompt" }, { prompt })),
    );
    const events = await collect(run);

    expect(events).toContainEqual({ type: "assistant_text", text: prompt });
  });
  it("tees raw stdout to logPath", async () => {
    // Also: the log and its directory are created (0600), and a later attempt appends.
    const fixture = await readFile(FIXTURE_429, "utf8");
    const replay = fakeSpec({ FAKE_CLAUDE_FIXTURE: FIXTURE_429 });

    for (let i = 0; i < 2; i += 1) await (await started(await worker().start(replay))).exit;

    expect(await readFile(replay.logPath, "utf8")).toBe(fixture + fixture);
    expect((await stat(replay.logPath)).mode & 0o777).toBe(0o600);
  });
  it("kills the whole process group on timeout and reports forced timeout", async () => {
    const pidFile = join(dir, "pids");
    const sleeper = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "sleep", FAKE_CLAUDE_PIDFILE: pidFile },
      { timeoutMs: 3000 },
    );

    const run = await started(await worker().start(sleeper));
    const pids = await groupPids(pidFile);
    const events = await collect(run);
    const exit = await run.exit;

    expect(exit).toEqual({ code: null, signal: "SIGTERM", stderrTail: "", forced: "timeout" });
    expect(events[0]).toMatchObject({ type: "init" });
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });
  it("returns no_key / insecure_key_file from loadKey without spawning", async () => {
    const noKey = { kind: "no_key", message: "no Z.ai key" } as const;
    const insecure = {
      kind: "insecure_key_file",
      path: "/home/dev/.config/zai-plugin-cc/env",
      mode: "0644",
    } as const;
    const target = fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" });

    const results = [];
    for (const error of [noKey, insecure])
      results.push(await worker({ loadKey: async () => err(error) }).start(target));

    expect(results).toEqual([
      { ok: false, error: noKey },
      { ok: false, error: insecure },
    ]);
    // The log is opened right before the spawn, so its absence proves nothing was started.
    await expect(stat(target.logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("returns spawn_failed when the binary does not exist", async () => {
    const missing = join(dir, "no-such-claude");

    const result = await worker({ bin: missing }).start(fakeSpec({}));

    expect(result).toEqual({
      ok: false,
      error: { kind: "spawn_failed", message: `spawn ${missing} ENOENT` },
    });
  });
  it("returns spawn_failed without spawning when the log cannot be opened", async () => {
    const notADirectory = join(dir, "file");
    await writeFile(notADirectory, "");
    const target = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "ok" },
      { logPath: join(notADirectory, "attempt-1.jsonl") },
    );

    const result = await worker().start(target);

    expect(result).toEqual({
      ok: false,
      // mkdir over a file: EEXIST on macOS, ENOTDIR on Linux.
      error: {
        kind: "spawn_failed",
        message: expect.stringContaining(`cannot open log ${target.logPath}: Error: E`),
      },
    });
  });

  it("the key never appears in argv, in logPath or in the fake's dumped argv (fake writes its argv/env names to a file)", async () => {
    // The real environment of this test run (which may itself be inside Claude Code) plus planted leaks.
    const parentEnv: Readonly<Record<string, string | undefined>> = {
      ...process.env,
      ...PARENT_ENV,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    const dumpPath = join(dir, "dump.json");
    const passEnv = { FAKE_CLAUDE_SCENARIO: "echo-prompt", FAKE_CLAUDE_DUMP: dumpPath };
    const target = fakeSpec(passEnv);

    const run = await started(await worker({ parentEnv }).start(target));
    await collect(run);
    await run.exit;
    const dumpText = await readFile(dumpPath, "utf8");
    const dump: { argv: string[]; envNames: string[]; authTokenSha256: string } = JSON.parse(dumpText);

    expect(dump.argv).toEqual(buildClaudeArgs(target));
    expect(dumpText).not.toContain(KEY);
    expect(await readFile(target.logPath, "utf8")).not.toContain(KEY);
    expect(dump.authTokenSha256).toBe(createHash("sha256").update(KEY).digest("hex"));
    const inherited = ENV_ALLOWLIST.filter((name) => parentEnv[name] !== undefined);
    const managed = [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "API_TIMEOUT_MS",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CONFIG_DIR",
    ];
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it does not come from the parent.
    const received = dump.envNames.filter((name) => name !== "__CF_USER_TEXT_ENCODING");
    expect(received).toEqual([...inherited, ...Object.keys(passEnv), ...managed].sort());
  });
  it("terminates processes the worker left running in its group once it exits", {
    timeout: 10_000,
  }, async () => {
    const pidFile = join(dir, "pids");
    const leaver = fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok", FAKE_CLAUDE_PIDFILE: pidFile });

    const run = await started(await worker().start(leaver));
    const pids = await groupPids(pidFile);
    await collect(run);
    const exit = await run.exit;

    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null });
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });

  it("a crashing worker resolves exit with its exit code and stderr", async () => {
    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "crash" })));

    await collect(run);

    expect(await run.exit).toEqual({
      code: 3,
      signal: null,
      stderrTail: "fake claude: simulated crash\n",
      forced: null,
    });
  });

  it("keeps only the last 4000 characters of stderr", async () => {
    const noisy = join(dir, "noisy-claude");
    await writeFile(noisy, "#!/bin/sh\nhead -c 10000 /dev/zero | tr '\\0' x >&2\nprintf END >&2\nexit 1\n", {
      mode: 0o755,
    });

    const run = await started(await worker({ bin: noisy }).start(fakeSpec({})));
    const exit = await run.exit;

    expect(exit.stderrTail).toHaveLength(4000);
    expect(exit.stderrTail.endsWith("xxxEND")).toBe(true);
  });

  it("a timeout beyond setTimeout's range (about 24.8 days) does not fire at once", async () => {
    const run = await started(
      await worker().start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" }, { timeoutMs: 2 ** 32 })),
    );

    await collect(run);

    expect(await run.exit).toMatchObject({ code: 0, forced: null });
  });

  it("skips lines the parser rejects (they stay in the log) and keeps streaming", async () => {
    const fixture = join(dir, "malformed.jsonl");
    const init = '{"type":"system","subtype":"init","session_id":"s-1","model":"glm-5.3"}';
    const said = '{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}';
    await writeFile(fixture, `${init}\n{"type": "assist\n\n${said}\n`);
    const replay = fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture });

    const run = await started(await worker().start(replay));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([
      { type: "init", sessionId: "s-1", model: "glm-5.3" },
      { type: "assistant_text", text: "still here" },
    ]);
    expect(await readFile(replay.logPath, "utf8")).toContain('{"type": "assist\n');
  });

  it("delivers every event of a line that parses to several, in order", async () => {
    const fixture = join(dir, "pair.jsonl");
    await writeFile(
      fixture,
      '{"type":"pair"}\n{"type":"assistant","message":{"content":[{"text":"after"}]}}\n',
    );

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([
      { type: "assistant_text", text: "first" },
      { type: "tool_use", name: "Bash", summary: "second" },
      { type: "assistant_text", text: "after" },
    ]);
  });

  it("parses a final line that has no trailing newline", async () => {
    const fixture = join(dir, "unterminated.jsonl");
    await writeFile(fixture, '{"type":"assistant","message":{"content":[{"type":"text","text":"last"}]}}');

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual([{ type: "assistant_text", text: "last" }]);
  });

  it("runs the worker in spec.cwd (the fake's edit-file scenario writes there)", async () => {
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const edit = fakeSpec(
      { FAKE_CLAUDE_SCENARIO: "edit-file", FAKE_CLAUDE_EDIT: "src/out.txt:hello from glm" },
      {
        cwd: workspace,
      },
    );

    const run = await started(await worker().start(edit));
    const events = await collect(run);
    await run.exit;

    expect(await readFile(join(workspace, "src", "out.txt"), "utf8")).toBe("hello from glm");
    expect(events).toContainEqual({ type: "assistant_text", text: "edited src/out.txt" });
  });

  it("by default parses with domain parseStreamLine", async () => {
    const defaultParser = new ClaudeHeadlessWorker({
      bin: FAKE_CLAUDE,
      configDir: join(dir, "claude-home"),
      loadKey: async () => ok(KEY),
      parentEnv: { PATH: process.env.PATH },
    });

    const run = await started(await defaultParser.start(fakeSpec({ FAKE_CLAUDE_SCENARIO: "ok" })));
    const events = await collect(run);
    await run.exit;

    expect(events.slice(0, 2)).toEqual([
      { type: "init", sessionId: SESSION, model: "glm-5.3" },
      { type: "assistant_text", text: "done" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      isError: false,
      text: "done",
      structuredOutput: { summary: "fake run" },
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
    });
  });

  it("delivers every line of a long stream, in order", async () => {
    const fixture = join(dir, "long.jsonl");
    const texts = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const line = (text: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    await writeFile(fixture, `${texts.map(line).join("\n")}\n`);

    const run = await started(await worker().start(fakeSpec({ FAKE_CLAUDE_FIXTURE: fixture })));
    const events = await collect(run);
    await run.exit;

    expect(events).toEqual(texts.map((text) => ({ type: "assistant_text", text })));
  });
});

describe("loadKey", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zai-key-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function keyFile(content: string, mode = 0o600): Promise<string> {
    const path = join(dir, "env");
    await writeFile(path, content);
    await chmod(path, mode);
    return path;
  }

  it("prefers ZAI_API_KEY from env", async () => {
    const file = await keyFile("ZAI_API_KEY=from-file\n");

    const fromEnv = await loadKey({ ZAI_API_KEY: "from-env" }, file);
    const missingFile = await loadKey({ ZAI_API_KEY: "from-env" }, join(dir, "missing"));

    expect(fromEnv).toEqual({ ok: true, value: "from-env" });
    expect(missingFile).toEqual({ ok: true, value: "from-env" });
  });
  it("reads ZAI_API_KEY= from the file, ignoring comments, blank lines, and surrounding quotes", async () => {
    const variants = [
      "ZAI_API_KEY=plain-key",
      '# Z.ai key\n\nOTHER=1\nZAI_API_KEY="double-quoted"\n',
      "  # ZAI_API_KEY=commented-out\nexport ZAI_API_KEY='single-quoted'  \n",
      "ZAI_API_KEY = spaced \r\n",
    ];

    const keys = [];
    for (const content of variants) keys.push(await loadKey({ ZAI_API_KEY: "  " }, await keyFile(content)));

    expect(keys).toEqual([
      { ok: true, value: "plain-key" },
      { ok: true, value: "double-quoted" },
      { ok: true, value: "single-quoted" },
      { ok: true, value: "spaced" },
    ]);
  });
  it("refuses a file readable by group or others, reporting its mode", async () => {
    const worldReadable = await loadKey({}, await keyFile("ZAI_API_KEY=secret-in-file", 0o644));
    const groupReadable = await loadKey({}, await keyFile("ZAI_API_KEY=secret-in-file", 0o640));
    const ownerOnly = await loadKey({}, await keyFile("ZAI_API_KEY=secret-in-file", 0o400));

    expect(worldReadable).toEqual({
      ok: false,
      error: { kind: "insecure_key_file", path: join(dir, "env"), mode: "0644" },
    });
    expect(groupReadable).toEqual({
      ok: false,
      error: { kind: "insecure_key_file", path: join(dir, "env"), mode: "0640" },
    });
    expect(ownerOnly).toEqual({ ok: true, value: "secret-in-file" });
  });
  it("no env and no file → no_key with a setup hint", async () => {
    const missing = join(dir, "missing");
    const withoutKeyLine = await keyFile("# nothing here\nOTHER=1\n");

    const noFile = await loadKey({}, missing);
    const noLine = await loadKey({ ZAI_API_KEY: "" }, withoutKeyLine);

    expect(noFile).toEqual({
      ok: false,
      error: {
        kind: "no_key",
        message: `no Z.ai key: export ZAI_API_KEY, or put ZAI_API_KEY=<key> in ${missing} (chmod 600)`,
      },
    });
    expect(noLine).toEqual({
      ok: false,
      error: {
        kind: "no_key",
        message: `no Z.ai key: export ZAI_API_KEY, or put ZAI_API_KEY=<key> in ${withoutKeyLine} (chmod 600)`,
      },
    });
  });

  it("expands a leading ~ from HOME (the default KEY_FILE)", async () => {
    await keyFile("ZAI_API_KEY=home-key");

    const found = await loadKey({ HOME: dir }, "~/env");
    const missing = await loadKey({ HOME: dir }, "~/missing");

    expect(KEY_FILE.startsWith("~/")).toBe(true);
    expect(found).toEqual({ ok: true, value: "home-key" });
    expect(missing.ok === false && missing.error.kind === "no_key" && missing.error.message).toContain(
      join(dir, "missing"),
    );
  });

  it("a key path that cannot be read (a directory) → no_key naming the error, not a throw", async () => {
    const result = await loadKey({}, dir);

    expect(result).toEqual({
      ok: false,
      error: { kind: "no_key", message: `cannot read Z.ai key file ${dir} (EISDIR)` },
    });
  });
});
