import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../support/tmp.ts";

const BUNDLE = join(import.meta.dirname, "../../plugins/zai/dist/zai.js");

function zai(args: readonly string[]): {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const home = tempDir("zai-bundle-");
  const run = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, ZAI_STATE_DIR: join(home, "state") },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

// The plugin runs the built bundle, not src/: it must load and run on its own.
describe("the built bundle", () => {
  it("loads and prints help", () => {
    const run = zai(["--help"]);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("zai run <brief.md|->");
  });

  it("board --hook is silent with nothing to report and exits 0", () => {
    expect(zai(["board", "--hook"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
