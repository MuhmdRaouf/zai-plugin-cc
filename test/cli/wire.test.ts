import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limiterConfig, stateRoot, wire } from "../../src/cli/wire.ts";
import { DEFAULT_LIMITER } from "../../src/domain/limiter.ts";
import { RecordingOutput } from "../support/fakes.ts";
import { tempDir } from "../support/tmp.ts";

const FAKE_CLAUDE = join(import.meta.dirname, "../support/fake-claude.ts");

/** A sandboxed environment: HOME points at a temp dir, so the key file lookup never reaches the real one. */
function sandbox(extra: Record<string, string> = {}): Record<string, string> {
  const home = tempDir("zai-wire-");
  return { HOME: home, PATH: process.env.PATH ?? "", ZAI_STATE_DIR: join(home, "state"), ...extra };
}

describe("wire", () => {
  it("state root: $ZAI_STATE_DIR, else zai's own $CLAUDE_PLUGIN_DATA, else $XDG_STATE_HOME/zai, else ~/.local/state/zai", () => {
    const zaiData = "/home/me/.claude/plugins/data/zai-muhmdraouf";
    expect(stateRoot({ ZAI_STATE_DIR: "/explicit", CLAUDE_PLUGIN_DATA: zaiData, HOME: "/home/me" })).toBe(
      "/explicit",
    );
    expect(stateRoot({ CLAUDE_PLUGIN_DATA: zaiData, XDG_STATE_HOME: "/xdg", HOME: "/home/me" })).toBe(
      zaiData,
    );
    expect(stateRoot({ XDG_STATE_HOME: "/xdg", HOME: "/home/me" })).toBe("/xdg/zai");
    expect(stateRoot({ HOME: "/home/me" })).toBe("/home/me/.local/state/zai");
  });

  it("ignores a $CLAUDE_PLUGIN_DATA that belongs to another plugin (it leaks into every Bash tool call)", () => {
    for (const other of [
      "/home/me/.claude/plugins/data/grok-build-xai-grok-build",
      "/data",
      "/x/zaiplugin-y",
    ]) {
      expect(stateRoot({ CLAUDE_PLUGIN_DATA: other, HOME: "/home/me" })).toBe("/home/me/.local/state/zai");
    }
  });

  it("ZAI_MAX_CONCURRENCY caps the limiter when it is a positive integer", () => {
    expect(limiterConfig({ ZAI_MAX_CONCURRENCY: "3" })).toEqual({ ...DEFAULT_LIMITER, max: 3 });
    for (const bad of [undefined, "", "0", "-2", "2.5", "lots"]) {
      expect(limiterConfig({ ZAI_MAX_CONCURRENCY: bad })).toEqual(DEFAULT_LIMITER);
    }
  });

  it("creates the state root and its claude-home config dir mode 0700, tightening an existing one", () => {
    const env = sandbox();
    const root = env.ZAI_STATE_DIR ?? "";
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);

    const deps = wire({ env, bundlePath: "/zai.js", out: new RecordingOutput() });

    expect(deps.host.stateRoot).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "claude-home")).mode & 0o777).toBe(0o700);
    expect(deps.config.stopGraceMs).toBe(10_000);
  });

  it("host reports the claude binary's version, or why it cannot run", async () => {
    const working = wire({
      env: sandbox({ ZAI_CLAUDE_BIN: FAKE_CLAUDE }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const missing = wire({
      env: sandbox({ ZAI_CLAUDE_BIN: "/nonexistent/claude" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });

    expect(working.host.claudeBin).toBe(FAKE_CLAUDE);
    expect(await working.host.claudeVersion()).toEqual({ ok: true, value: "2.1.289 (Claude Code, fake)" });
    expect(await missing.host.claudeVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("ENOENT"),
    });
    expect(wire({ env: sandbox(), bundlePath: "/zai.js", out: new RecordingOutput() }).host.claudeBin).toBe(
      "claude",
    );
  });

  it("key source names ZAI_API_KEY or the key file, never the key; no key is the loader's error", async () => {
    const fromEnv = wire({
      env: sandbox({ ZAI_API_KEY: "sk-zai-secret" }),
      bundlePath: "/zai.js",
      out: new RecordingOutput(),
    });
    const none = wire({ env: sandbox(), bundlePath: "/zai.js", out: new RecordingOutput() });

    expect(await fromEnv.host.keySource()).toEqual({ ok: true, value: "ZAI_API_KEY" });
    expect(await none.host.keySource()).toEqual({
      ok: false,
      error: { kind: "no_key", message: expect.stringContaining("no Z.ai key: export ZAI_API_KEY") },
    });
  });

  it("passes the output port and the environment through", () => {
    const out = new RecordingOutput();
    const deps = wire({ env: sandbox(), bundlePath: "/zai.js", out });

    deps.out.line("hello");

    expect(out.lines).toEqual(["hello"]);
    expect(deps.env.ZAI_STATE_DIR).toBe(deps.host.stateRoot);
  });
});
