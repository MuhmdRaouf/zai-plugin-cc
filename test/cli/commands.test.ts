import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drive } from "../../src/app/drive.ts";
import { EXIT, runCli } from "../../src/cli/run.ts";
import type { Job } from "../../src/domain/job.ts";
import { err } from "../../src/domain/result.ts";
import { aBrief, aChangeSet, aJob, anAttempt, aVerification } from "../support/builders.ts";
import { type Fakes, fakeDeps, VALID_CHANGE_REPORT } from "../support/fakes.ts";

const BRIEF = "---\ntitle: Rename foo\ncwd: /repo\n---\nRename `foo` to `bar`.\n";

function cli(fakes: Fakes, ...argv: string[]): Promise<number> {
  return runCli(argv, fakes.deps, "/repo");
}

function write(fakes: Fakes, name: string, text: string): string {
  const path = join(fakes.root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function reviewable(fakes: Fakes, overrides: Partial<Job> = {}): Job {
  const paths = fakes.store.paths("j1");
  return fakes.store.put(
    aJob({
      id: "j1",
      state: "awaiting_review",
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        worktree: paths.worktree,
        branch: "zai/j1",
        artifactsDir: paths.artifacts,
      },
      attempts: [anAttempt({ report: VALID_CHANGE_REPORT, verification: aVerification(), verdict: "pass" })],
      ...overrides,
    }),
  );
}

describe("runCli commands (edge cases)", () => {
  it.each([
    ["show", "show needs a job id"],
    ["accept", "accept needs a job id"],
    ["discard", "discard needs a job id"],
    ["return", "return needs a job id"],
    ["drive", "drive needs a job id"],
    ["run", "run needs a brief path (- reads stdin)"],
    ["batch", "batch needs a directory, a glob or a manifest file"],
  ])("%s without its argument is a usage error", async (command, message) => {
    const fakes = fakeDeps();

    expect(await cli(fakes, command)).toBe(EXIT.usage);
    expect(fakes.out.errors[0]).toBe(`zai: ${message}`);
    expect(fakes.out.errors[1]).toMatch(new RegExp(`^usage: zai ${command} `));
  });

  it("no command at all, or `help`, and per-command --help", async () => {
    const none = fakeDeps();
    expect(await cli(none)).toBe(EXIT.usage);
    expect(none.out.errors[0]).toBe("zai: which command?");

    const help = fakeDeps();
    expect(await cli(help, "help")).toBe(EXIT.ok);
    expect(help.out.lines[0]).toBe("usage:");

    const brief = fakeDeps();
    expect(await cli(brief, "brief", "--help")).toBe(EXIT.ok);
    expect(brief.out.lines).toEqual([
      "usage: zai brief new <title> [--mode edit|exec|readonly]",
      "       zai brief lint <path>",
    ]);
  });

  it("accept explains a dirty working tree; other git failures are one line", async () => {
    const dirty = fakeDeps();
    reviewable(dirty);
    dirty.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    dirty.git.pickResult = err({ kind: "dirty", paths: ["src/a.ts"] });

    expect(await cli(dirty, "accept", "j1")).toBe(EXIT.conflict);
    expect(dirty.out.errors).toEqual([
      "zai: uncommitted changes in the way: src/a.ts: nothing was applied. Commit or stash them, then accept again.",
    ]);

    const broken = fakeDeps();
    reviewable(broken);
    broken.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    broken.git.pickResult = err({ kind: "git_failed", command: "git cherry-pick", stderr: "boom" });

    expect(await cli(broken, "accept", "j1")).toBe(EXIT.unexpected);
    expect(broken.out.errors).toEqual(["zai: git cherry-pick: boom"]);

    const unknown = fakeDeps();
    expect(await cli(unknown, "accept", "nope")).toBe(EXIT.notFound);
  });

  it("accept, return and discard print the job with --json; discard without a reason", async () => {
    const accepted = fakeDeps();
    reviewable(accepted, { brief: aBrief({ mode: "readonly", scope: [] }) });
    await cli(accepted, "accept", "j1", "--json");
    expect(JSON.parse(accepted.out.text)).toMatchObject({ id: "j1", state: "accepted" });

    const returned = fakeDeps();
    reviewable(returned);
    await cli(returned, "return", "j1", "again", "--json");
    expect(JSON.parse(returned.out.text)).toMatchObject({ id: "j1", state: "queued" });

    const discarded = fakeDeps();
    reviewable(discarded);
    await cli(discarded, "discard", "j1", "--json");
    expect(JSON.parse(discarded.out.text)).toMatchObject({ id: "j1", state: "discarded" });

    const plain = fakeDeps();
    reviewable(plain);
    expect(await cli(plain, "discard", "j1", "--reason", "  ")).toBe(EXIT.ok);
    expect(plain.out.lines).toEqual(["zai job j1 discarded"]);
    expect(await cli(plain, "return", "nope", "fix it")).toBe(EXIT.notFound);
    expect(await cli(plain, "discard", "nope")).toBe(EXIT.notFound);
  });

  it("stop reports each failure and keeps going; --all with nothing to stop says so; --json lists the stopped jobs", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j-idle", state: "queued" }));

    expect(await cli(fakes, "stop", "nope", "j-idle")).toBe(EXIT.notFound);
    expect(fakes.out.errors).toEqual(['zai: no zai job matches "nope" (zai board lists them)']);
    expect(fakes.out.lines).toEqual(["zai job j-idle stopped: awaiting review"]);

    const empty = fakeDeps();
    expect(await runCli(["stop", "--all"], empty.deps, "/elsewhere")).toBe(EXIT.ok);
    expect(empty.out.lines).toEqual(["zai: no queued or running job to stop"]);

    const json = fakeDeps();
    json.store.put(aJob({ id: "j-idle", state: "queued" }));
    await cli(json, "stop", "--all", "--json");
    expect(JSON.parse(json.out.text)).toMatchObject([{ id: "j-idle", state: "awaiting_review" }]);
  });

  it("show --follow --json prints only the settled row; show stops following a job whose driver is gone", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));

    expect(await cli(fakes, "show", "j1", "--follow", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(fakes.out.text)).toMatchObject({ job: { id: "j1" }, live: false });

    const live = fakeDeps();
    const job = live.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    live.store.holdLock("j1", process.pid);
    const sleep = live.clock.sleep.bind(live.clock);
    live.deps.clock.sleep = async (ms, signal) => {
      live.store.put({ ...job, state: "awaiting_review" });
      await sleep(ms, signal);
    };
    await cli(live, "show", "j1", "--follow", "--json");
    expect(live.out.lines).toHaveLength(1);
  });

  it("usage --json and review of an unknown job", async () => {
    const fakes = fakeDeps();
    reviewable(fakes, { state: "accepted" });

    expect(await cli(fakes, "usage", "--all", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(fakes.out.text)).toEqual(expect.any(Array));
    expect(await cli(fakes, "review", "nope")).toBe(EXIT.notFound);
  });

  it("run --wait --json prints the settled job; run passes a submit failure through", async () => {
    const fakes = fakeDeps();
    const brief = write(fakes, "b.md", BRIEF);
    fakes.process.onSpawn = (id) => {
      void drive(fakes.deps, id);
    };

    expect(await cli(fakes, "run", brief, "--wait", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(fakes.out.text)).toMatchObject({ state: "awaiting_review" });

    const outside = fakeDeps();
    const elsewhere = write(outside, "b.md", "---\ntitle: T\ncwd: /nowhere\n---\nDo it.\n");
    expect(await cli(outside, "run", elsewhere)).toBe(EXIT.unexpected);
    expect(outside.out.errors).toEqual(["zai: not a git repository: /nowhere"]);
  });

  it("drive passes a failure through", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "drive", "nope")).toBe(EXIT.notFound);
  });

  it("batch takes a single brief file; unreadable manifest entries are rejected; --json lists rejections", async () => {
    const fakes = fakeDeps();
    const one = write(fakes, "one.md", BRIEF);

    expect(await cli(fakes, "batch", one)).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([`submitted 261006-job001: Rename foo (${one})`]);

    const listed = fakeDeps();
    const manifest = write(listed, "jobs.txt", "missing.md\n");
    expect(await cli(listed, "batch", manifest, "--json")).toBe(EXIT.usage);
    expect(JSON.parse(listed.out.text)).toEqual({
      submitted: [],
      rejected: [
        {
          path: join(listed.root, "missing.md"),
          error: expect.stringMatching(/^cannot read .*missing\.md: ENOENT/),
        },
      ],
    });
  });

  it("brief new: a bad mode or no title is a usage error; a title without letters gets the slug brief", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "brief", "new", "X", "--mode", "yolo")).toBe(EXIT.usage);
    expect(await cli(fakes, "brief", "new")).toBe(EXIT.usage);
    expect(await cli(fakes, "brief", "lint")).toBe(EXIT.usage);
    expect(fakes.out.errors.filter((line) => line.startsWith("zai: "))).toEqual([
      "zai: --mode must be edit, exec or readonly",
      "zai: brief new needs a title",
      "zai: brief lint needs a path",
    ]);
    expect(await cli(fakes, "brief", "new", "!!!")).toBe(EXIT.ok);
    expect(fakes.out.lines).toEqual([join(fakes.root, "briefs", "brief.md")]);
  });

  it("brief lint: an unreadable file, and a valid brief whose env names are unset", async () => {
    const fakes = fakeDeps();
    const brief = write(fakes, "env.md", "---\ntitle: T\nenv: [TOKEN]\n---\nDo it.\n");

    expect(await cli(fakes, "brief", "lint", "/nope.md")).toBe(EXIT.usage);
    expect(fakes.out.errors[0]).toMatch(/^zai: cannot read \/nope\.md: ENOENT/);
    expect(await cli(fakes, "brief", "lint", brief)).toBe(EXIT.usage);
    expect(fakes.out.lines).toEqual([
      `${brief}: the brief's env names are not set in this environment: TOKEN`,
    ]);
  });

  it("setup renders failed checks as text and skips the ping when not ready; a ping that cannot start fails", async () => {
    const broken = fakeDeps();
    broken.host.version = err("spawn claude ENOENT");
    broken.host.keyResult = err({ kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" });

    expect(await cli(broken, "setup", "--ping")).toBe(EXIT.notReady);
    expect(broken.out.text).toContain("  claude: /usr/local/bin/claude: FAILED: spawn claude ENOENT");
    expect(broken.out.text).toContain("  key:    MISSING: no Z.ai key: export ZAI_API_KEY");
    expect(broken.out.text).toMatch(/\nnot ready$/);
    expect(broken.worker.specs).toEqual([]);

    const unstartable = fakeDeps([{ startError: { kind: "spawn_failed", message: "EACCES" } }]);
    expect(await cli(unstartable, "setup", "--ping")).toBe(EXIT.notReady);
    expect(unstartable.out.text).toContain("  ping:   FAILED: cannot start claude: EACCES");
  });
});
