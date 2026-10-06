import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { errnoCode, errorMessage } from "../../src/adapters/fs-errors.ts";
import { tryLock } from "../../src/adapters/fs-lock.ts";
import { createFsLimiter, createFsSemaphore, createFsStore } from "../../src/adapters/fs-store.ts";
import type { Job } from "../../src/domain/job.ts";
import type { LimiterConfig } from "../../src/domain/limiter.ts";
import { isPidAlive, tempDir } from "../support/tmp.ts";

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    brief: {
      title: `job ${id}`,
      body: "Do the thing.",
      model: "glm",
      mode: "edit",
      cwd: "/repo",
      base: "HEAD",
      scope: ["**"],
      forbid: [],
      gates: [{ run: "npm test", timeoutMs: 600_000 }],
      timeoutMs: 7_200_000,
      retries: { fix: 1, infra: 2 },
      report: { kind: "builtin", name: "change" },
      addDirs: [],
      env: [],
      tags: [],
    },
    state: "queued",
    workspace: { repoRoot: "/repo", baseSha: "a".repeat(40), artifactsDir: "/state/artifacts" },
    attempts: [],
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    version: 0,
    ...overrides,
  };
}

const STORE_MODULE = new URL("../../src/adapters/fs-store.ts", import.meta.url).href;

/** Spawns n copies of script, releases them at once (a "go" file in dir) and collects what each `report`ed. */
async function runTogether(
  dir: string,
  script: string,
  args: readonly string[],
  n: number,
): Promise<Record<string, unknown>[]> {
  const children = Array.from({ length: n }, () =>
    spawn(process.execPath, [script, dir, ...args], { stdio: ["ignore", "pipe", "inherit"] }),
  );
  // A failed assertion must not leave children waiting for "go" (they would keep the test run alive).
  onTestFinished(() => {
    for (const child of children) child.kill("SIGKILL");
  });
  const outputs = children.map(async (child) => {
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
    });
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`child ${child.pid} exited with ${code}`);
    return text;
  });
  // Generous: node start-up is slow on a loaded machine.
  await expect
    .poll(() => readdirSync(dir).filter((name) => name.startsWith("ready-")).length, { timeout: 15_000 })
    .toBe(n);
  writeFileSync(join(dir, "go"), "");
  const texts = await Promise.all(outputs);
  return texts.flatMap((text) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line): Record<string, unknown> => JSON.parse(line)),
  );
}

/** A node script (run with the real store, types stripped by node) with `store`, `id`, `root` and `isAlive` in scope;
 *  `prelude` runs before the store module is loaded. */
function childScript(dir: string, body: string, prelude = ""): string {
  const path = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `${prelude}
     const { createFsStore, createFsSemaphore } = await import(${JSON.stringify(STORE_MODULE)});
     const [root, id] = process.argv.slice(2);
     const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
     const store = createFsStore(root, isAlive);
     const report = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
     const startTogether = async (dir) => {
       const { existsSync, writeFileSync } = await import("node:fs");
       writeFileSync(dir + "/ready-" + process.pid, "");
       const deadline = Date.now() + 30_000;
       while (!existsSync(dir + "/go")) {
         if (Date.now() > deadline) process.exit(3);
         await new Promise((r) => setTimeout(r, 2));
       }
     };
     ${body}`,
  );
  return path;
}

describe("fs job store", () => {
  it("create then get round-trips the job; create twice errors", async () => {
    const store = createFsStore(tempDir(), isPidAlive);
    const original = job("261006-abc123");

    const created = await store.create(original);
    const again = await store.create(original);

    expect(created).toEqual({ ok: true, value: { ...original, version: 1 } });
    expect(await store.get(original.id)).toEqual(created);
    expect(again).toEqual({ ok: false, error: { kind: "io", message: "job 261006-abc123 already exists" } });
    expect(await store.get("261006-zzzzzz")).toEqual({
      ok: false,
      error: { kind: "not_found", id: "261006-zzzzzz" },
    });
  });
  it("update with a stale version → version_conflict; with the current version bumps it", async () => {
    const store = createFsStore(tempDir(), isPidAlive);
    const created = await store.create(job("261006-upd001"));
    if (!created.ok) throw new Error(created.error.kind);
    const running: Job = { ...created.value, state: "running" };

    const updated = await store.update(running);
    const stale = await store.update({ ...created.value, state: "discarded" });
    const missing = await store.update(job("261006-nope00"));

    expect(updated).toEqual({ ok: true, value: { ...running, version: 2 } });
    expect(stale).toEqual({
      ok: false,
      error: { kind: "version_conflict", id: "261006-upd001", expected: 1, actual: 2 },
    });
    expect(await store.get("261006-upd001")).toEqual(updated);
    expect(missing).toEqual({ ok: false, error: { kind: "not_found", id: "261006-nope00" } });
  });

  it("concurrent updates from the same version: exactly one wins", async () => {
    const store = createFsStore(tempDir(), isPidAlive);
    const created = await store.create(job("261006-race01"));
    if (!created.ok) throw new Error(created.error.kind);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.update({ ...created.value, updatedAt: `writer ${i}` })),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.kind === "version_conflict")).toHaveLength(
      7,
    );
    const stored = await store.get("261006-race01");
    expect(stored.ok && stored.value.version).toBe(2);
  });
  it("writes are atomic: a crash between tmp write and rename never leaves a torn job.json", async () => {
    const root = tempDir();
    const store = createFsStore(root, isPidAlive);
    const created = await store.create(job("261006-crash1"));
    if (!created.ok) throw new Error(created.error.kind);
    // The writer dies (SIGKILL, no cleanup) at the instant it would rename its fsynced tmp file over job.json.
    const writer = childScript(
      root,
      `const current = await store.get(id);
       await store.update({ ...current.value, state: "running" });`,
      `import fsp from "node:fs/promises";
       import { syncBuiltinESMExports } from "node:module";
       fsp.rename = async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };
       syncBuiltinESMExports();`,
    );

    const child = spawn(process.execPath, [writer, root, "261006-crash1"], { stdio: "inherit" });
    const [, signal] = await once(child, "exit");

    expect(signal).toBe("SIGKILL");
    const dir = join(root, "jobs", "261006-crash1");
    expect(readdirSync(dir)).toEqual(expect.arrayContaining([`job.json.${child.pid}.tmp`, "job.json.lock"]));
    expect(await store.get("261006-crash1")).toEqual(created);
    // The dead writer's write lock is reclaimed and its tmp file never read.
    const next = await store.update({ ...created.value, state: "running" });
    expect(next).toEqual({ ok: true, value: { ...created.value, state: "running", version: 2 } });
  });

  it("random SIGKILLs of a busy writer never leave job.json unreadable", async () => {
    const root = tempDir();
    const store = createFsStore(root, isPidAlive);
    const created = await store.create(job("261006-crash2"));
    if (!created.ok) throw new Error(created.error.kind);
    const writer = childScript(
      root,
      `const big = "x".repeat(2_000_000);
       for (let n = 0; ; n++) {
         const current = await store.get(id);
         if (!current.ok) throw new Error(JSON.stringify(current.error));
         const prompt = big + n;
         await store.update({ ...current.value, attempts: [{ n, kind: "initial", prompt, sessionId: "s", startedAt: "t" }] });
         if (n === 0) process.stdout.write("ready\\n");
       }`,
    );
    let version = created.value.version;

    for (let round = 0; round < 6; round++) {
      const child = spawn(process.execPath, [writer, root, "261006-crash2"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await once(child.stdout, "data");
      await delay(Math.random() * 40);
      child.kill("SIGKILL");
      await once(child, "exit");

      const survived = await store.get("261006-crash2");
      if (!survived.ok) throw new Error(`round ${round}: ${JSON.stringify(survived.error)}`);
      expect(survived.value.version).toBeGreaterThan(version);
      const next = await store.update(survived.value);
      if (!next.ok) throw new Error(`round ${round}: ${JSON.stringify(next.error)}`);
      version = next.value.version;
    }
  }, 60_000);
  it("find resolves a unique prefix; ambiguous or missing prefix → not_found", async () => {
    const store = createFsStore(tempDir(), isPidAlive);
    for (const id of ["261006-aaa111", "261006-aab222", "261007-ccc333"]) await store.create(job(id));
    const idOf = async (prefix: string) => {
      const found = await store.find(prefix);
      return found.ok ? found.value.id : found.error;
    };

    expect(await idOf("261006-aaa111")).toBe("261006-aaa111");
    expect(await idOf("261006-aab")).toBe("261006-aab222");
    expect(await idOf("261007")).toBe("261007-ccc333");
    expect(await idOf("261006-aa")).toEqual({ kind: "not_found", id: "261006-aa" });
    expect(await idOf("261008")).toEqual({ kind: "not_found", id: "261008" });
    expect(await idOf("")).toEqual({ kind: "not_found", id: "" });
    expect(await idOf("../jobs")).toEqual({ kind: "not_found", id: "../jobs" });
  });

  it("find and list on an empty store find nothing", async () => {
    const store = createFsStore(join(tempDir(), "never-created"), isPidAlive);
    expect(await store.find("261006")).toEqual({ ok: false, error: { kind: "not_found", id: "261006" } });
    expect(await store.list()).toEqual([]);
  });
  it("list returns jobs newest first, filtered by repoRoot", async () => {
    const root = tempDir();
    const store = createFsStore(root, isPidAlive);
    const at = (id: string, createdAt: string, repoRoot: string) =>
      job(id, { createdAt, workspace: { repoRoot, baseSha: "b".repeat(40), artifactsDir: "/a" } });
    await store.create(at("261006-old000", "2026-10-06T08:00:00.000Z", "/repo/one"));
    await store.create(at("261006-new000", "2026-10-06T12:00:00.000Z", "/repo/one"));
    await store.create(at("261006-mid000", "2026-10-06T10:00:00.000Z", "/repo/two"));
    await store.create(at("261006-tie000", "2026-10-06T10:00:00.000Z", "/repo/one"));
    // Neither a half-created job directory nor a foreign or corrupt file breaks the listing.
    mkdirSync(join(root, "jobs", "261006-empty0"));
    mkdirSync(join(root, "jobs", "261006-junk00"));
    writeFileSync(join(root, "jobs", "261006-junk00", "job.json"), '{"id": "261006-junk00", "trunc');
    writeFileSync(join(root, "jobs", "README"), "not a job");

    const ids = (jobs: readonly Job[]) => jobs.map((listed) => listed.id);

    expect(ids(await store.list())).toEqual([
      "261006-new000",
      "261006-tie000",
      "261006-mid000",
      "261006-old000",
    ]);
    expect(ids(await store.list({ repoRoot: "/repo/one" }))).toEqual([
      "261006-new000",
      "261006-tie000",
      "261006-old000",
    ]);
    expect(await store.list({ repoRoot: "/repo/none" })).toEqual([]);
    expect(await store.get("261006-junk00")).toEqual({
      ok: false,
      error: { kind: "io", message: expect.stringContaining("261006-junk00: unreadable job.json") },
    });
  });
  it("lock is exclusive; a second lock → locked with holder pid; a dead holder is reclaimed; release frees it", async () => {
    const alive = new Set([101, 202, 303]);
    const store = createFsStore(tempDir(), (pid) => alive.has(pid));
    await store.create(job("261006-lock01"));

    const first = await store.lock("261006-lock01", 101);
    const second = await store.lock("261006-lock01", 202);
    const sameHolder = await store.lock("261006-lock01", 101);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: { kind: "locked", id: "261006-lock01", holderPid: 101 } });
    expect(sameHolder).toEqual({ ok: false, error: { kind: "locked", id: "261006-lock01", holderPid: 101 } });

    alive.delete(101);
    const reclaimed = await store.lock("261006-lock01", 202);
    expect(reclaimed.ok).toBe(true);
    // The dead holder's late release must not free the new holder's lock.
    if (first.ok) await first.value();
    expect(await store.lock("261006-lock01", 303)).toEqual({
      ok: false,
      error: { kind: "locked", id: "261006-lock01", holderPid: 202 },
    });

    if (reclaimed.ok) await reclaimed.value();
    const third = await store.lock("261006-lock01", 303);
    expect(third.ok).toBe(true);
    expect(await store.lock("261006-nope00", 303)).toEqual({
      ok: false,
      error: { kind: "not_found", id: "261006-nope00" },
    });
  });

  it("ids that are not plain names are refused rather than turned into paths", async () => {
    const store = createFsStore(tempDir(), isPidAlive);
    expect(await store.create(job("../escape"))).toEqual({
      ok: false,
      error: { kind: "io", message: 'invalid job id "../escape"' },
    });
    expect(await store.get("../escape")).toEqual({
      ok: false,
      error: { kind: "not_found", id: "../escape" },
    });
    expect(await store.lock("a/b", 1)).toEqual({ ok: false, error: { kind: "not_found", id: "a/b" } });
  });

  it("damaged state is reported as io, not thrown", async () => {
    const root = tempDir();
    const store = createFsStore(root, isPidAlive);
    await store.create(job("261006-dmg001"));
    await store.create(job("261006-dmg002"));
    const dir = (id: string) => join(root, "jobs", id);
    writeFileSync(
      join(dir("261006-dmg001"), "job.json"),
      JSON.stringify({ id: "261006-dmg001", version: "one" }),
    );
    mkdirSync(join(dir("261006-dmg002"), "driver.lock"));

    expect(await store.get("261006-dmg001")).toEqual({
      ok: false,
      error: { kind: "io", message: expect.stringContaining("261006-dmg001: unreadable job.json") },
    });
    const locked = await store.lock("261006-dmg002", 1);
    expect(locked.ok ? "ok" : locked.error.kind).toBe("io");

    rmSync(join(dir("261006-dmg002"), "job.json"));
    mkdirSync(join(dir("261006-dmg002"), "job.json"));
    const read = await store.get("261006-dmg002");
    expect(read.ok ? "ok" : read.error.kind).toBe("io");

    const brokenRoot = tempDir();
    writeFileSync(join(brokenRoot, "jobs"), "a file where the jobs directory should be");
    const broken = await createFsStore(brokenRoot, isPidAlive).find("261006");
    expect(broken.ok ? "ok" : broken.error.kind).toBe("io");
  });

  it("several processes racing for one driver lock: exactly one wins, the others see its pid", async () => {
    const root = tempDir();
    const store = createFsStore(root, isPidAlive);
    await store.create(job("261006-race02"));
    const script = childScript(
      root,
      `await startTogether(root);
       const lock = await store.lock(id, process.pid);
       report(lock.ok ? { won: process.pid } : lock.error);
       if (lock.ok) { await new Promise((r) => setTimeout(r, 1000)); await lock.value(); }`,
    );

    const reports = await runTogether(root, script, ["261006-race02"], 6);

    const winners = reports.filter((report) => "won" in report);
    expect(winners).toHaveLength(1);
    const winner = winners[0]?.won;
    expect(reports.filter((report) => report.kind === "locked" && report.holderPid === winner)).toHaveLength(
      5,
    );
  }, 60_000);
});

/** A poll that keeps tests fast but still yields to the event loop; rejects on abort like a real sleep. */
const fastSleep = (_ms: number, signal?: AbortSignal) => delay(5, undefined, signal ? { signal } : {});

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: boolean } {
  const tracked = { promise, settled: false };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    },
  );
  return tracked;
}

describe("fs lock files", () => {
  it("garbage in a lock file counts as nobody holding it", async () => {
    const path = join(tempDir(), "x.lock");
    writeFileSync(path, "not a pid");
    const lock = await tryLock(path, 101, () => true);
    expect(lock.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("101\n");
  });

  it("a reclaim guard left by a dead reclaimer is cleared; a live one defers the reclaim", async () => {
    const dir = tempDir();
    const path = join(dir, "x.lock");
    const alive = new Set([101, 303]);
    writeFileSync(path, "202\n");
    writeFileSync(`${path}.reclaim`, "303\n");

    expect(await tryLock(path, 101, (pid) => alive.has(pid))).toEqual({
      ok: false,
      error: { holderPid: 202 },
    });
    alive.delete(303);
    const lock = await tryLock(path, 101, (pid) => alive.has(pid));
    expect(lock.ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["x.lock"]);
  });

  it("errno helpers tolerate non-errno values", () => {
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode("ENOENT")).toBeUndefined();
    expect(errorMessage("text")).toBe("text");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("fs semaphore", () => {
  it("grants up to capacity holders and blocks the next until a release", async () => {
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => 2,
      () => true,
      fastSleep,
    );

    const first = await semaphore.acquire({ jobId: "job-a", pid: 101 });
    await semaphore.acquire({ jobId: "job-b", pid: 202 });
    const third = track(semaphore.acquire({ jobId: "job-c", pid: 303 }));
    await delay(60);

    expect(third.settled).toBe(false);
    expect(await semaphore.held()).toEqual([
      { jobId: "job-a", pid: 101 },
      { jobId: "job-b", pid: 202 },
    ]);
    await first();
    await third.promise;
    expect(await semaphore.held()).toEqual([
      { jobId: "job-b", pid: 202 },
      { jobId: "job-c", pid: 303 },
    ]);
  });
  it("re-reads capacity on every poll (a lowered cap blocks new acquisitions, never revokes held slots)", async () => {
    let cap = 2;
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => cap,
      () => true,
      fastSleep,
    );
    const first = await semaphore.acquire({ jobId: "job-a", pid: 101 });
    await semaphore.acquire({ jobId: "job-b", pid: 202 });

    cap = 1;
    const third = track(semaphore.acquire({ jobId: "job-c", pid: 303 }));
    await first();
    await delay(60);
    expect(third.settled).toBe(false);
    expect(await semaphore.held()).toEqual([{ jobId: "job-b", pid: 202 }]);

    cap = 3;
    await third.promise;
    expect(await semaphore.held()).toEqual([
      { jobId: "job-b", pid: 202 },
      { jobId: "job-c", pid: 303 },
    ]);
  });
  it("reclaims slots held by dead pids", async () => {
    const alive = new Set([101, 202, 303]);
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => 2,
      (pid) => alive.has(pid),
      fastSleep,
    );
    const crashed = await semaphore.acquire({ jobId: "job-a", pid: 101 });
    await semaphore.acquire({ jobId: "job-b", pid: 202 });

    alive.delete(101);
    expect(await semaphore.held()).toEqual([{ jobId: "job-b", pid: 202 }]);
    await semaphore.acquire({ jobId: "job-c", pid: 303 });
    // job-a is re-driven by a new process while its dead driver's slot file is still there.
    alive.add(404);
    const redriven = track(semaphore.acquire({ jobId: "job-a", pid: 404 }));
    await delay(60);
    expect(redriven.settled).toBe(false);
    expect(await semaphore.held()).toEqual([
      { jobId: "job-b", pid: 202 },
      { jobId: "job-c", pid: 303 },
    ]);
    alive.delete(202);
    await redriven.promise;
    // A late release by the dead driver (pid 101) must not free the slot job-a's new driver holds.
    await crashed();
    expect(await semaphore.held()).toEqual([
      { jobId: "job-a", pid: 404 },
      { jobId: "job-c", pid: 303 },
    ]);
  });
  it("a job that already holds a slot waits for it rather than taking a second one", async () => {
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => 5,
      () => true,
      fastSleep,
    );
    const first = await semaphore.acquire({ jobId: "job-a", pid: 101 });
    const again = track(semaphore.acquire({ jobId: "job-a", pid: 101 }));
    await delay(40);
    expect(again.settled).toBe(false);
    await first();
    await again.promise;
    expect(await semaphore.held()).toEqual([{ jobId: "job-a", pid: 101 }]);
  });

  it("an aborted acquire rejects and holds nothing", async () => {
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => 1,
      () => true,
      fastSleep,
    );
    const first = await semaphore.acquire({ jobId: "job-a", pid: 101 });
    const controller = new AbortController();
    const waiting = semaphore.acquire({ jobId: "job-b", pid: 202 }, controller.signal);
    await delay(30);

    controller.abort(new Error("stopped by user"));

    await expect(waiting).rejects.toThrow("stopped by user");
    expect(await semaphore.held()).toEqual([{ jobId: "job-a", pid: 101 }]);
    await first();
    await expect(semaphore.acquire({ jobId: "job-c", pid: 303 }, controller.signal)).rejects.toThrow(
      "stopped by user",
    );
    expect(await semaphore.held()).toEqual([]);
  });

  it("an abort that lands while a slot is being taken gives the slot back", async () => {
    const controller = new AbortController();
    const semaphore = createFsSemaphore(
      tempDir(),
      async () => {
        controller.abort(new Error("late abort"));
        return 1;
      },
      () => true,
      fastSleep,
    );

    await expect(semaphore.acquire({ jobId: "job-a", pid: 101 }, controller.signal)).rejects.toThrow(
      "late abort",
    );
    expect(await semaphore.held()).toEqual([]);
  });

  it("several processes share the cap: never more than capacity holders at once", async () => {
    const root = tempDir();
    const script = childScript(
      root,
      `const { appendFileSync } = await import("node:fs");
       const sleep = () => new Promise((r) => setTimeout(r, 1 + Math.random() * 3));
       const semaphore = createFsSemaphore(root, async () => 2, isAlive, sleep);
       await startTogether(root);
       for (let round = 0; round < 6; round++) {
         const release = await semaphore.acquire({ jobId: "job-" + process.pid, pid: process.pid });
         appendFileSync(root + "/events.log", "enter " + process.pid + "\\n");
         await new Promise((r) => setTimeout(r, 15));
         appendFileSync(root + "/events.log", "exit " + process.pid + "\\n");
         await release();
       }`,
    );

    await runTogether(root, script, [], 8);

    // "enter" is logged after acquire and "exit" before release, so the log can only under-count real holders.
    const events = readFileSync(join(root, "events.log"), "utf8").split("\n").filter(Boolean);
    let holders = 0;
    let most = 0;
    for (const event of events) {
      holders += event.startsWith("enter") ? 1 : -1;
      most = Math.max(most, holders);
    }
    expect(events.filter((event) => event.startsWith("enter"))).toHaveLength(48);
    expect(most).toBe(2);
    expect(readdirSync(join(root, "slots")).filter((name) => name.endsWith(".slot"))).toEqual([]);
  }, 60_000);
});

describe("fs limiter", () => {
  const config: LimiterConfig = {
    min: 1,
    max: 4,
    decreaseFactor: 0.5,
    cooldownMs: 1_000,
    increaseAfterMs: 5_000,
  };

  it("capacity starts at config.max and drops after rateLimited, recovering via tick on later reads", async () => {
    const root = tempDir();
    const limiter = createFsLimiter(root, config);

    const initial = await limiter.capacity(0);
    await limiter.rateLimited(10);
    const dropped = await createFsLimiter(root, config).capacity(20);
    const stillQuiet = await limiter.capacity(5_009);
    const recovered = await limiter.capacity(5_010);
    const again = await limiter.capacity(5_011);

    expect([initial, dropped, stillQuiet, recovered, again]).toEqual([4, 2, 2, 3, 3]);
    expect(JSON.parse(readFileSync(join(root, "limiter.json"), "utf8"))).toEqual({
      cap: 3,
      lastDecreaseAt: 10,
      quietSince: 5_010,
    });
  });

  it("a stored cap outside a changed [min, max] is clamped; an unreadable state file starts over", async () => {
    const root = tempDir();
    await createFsLimiter(root, { ...config, max: 8 }).capacity(0);

    const lowered = await createFsLimiter(root, { ...config, max: 2 }).capacity(1);
    writeFileSync(join(root, "limiter.json"), "{ torn");
    const restarted = await createFsLimiter(root, config).capacity(2);

    expect([lowered, restarted]).toEqual([2, 4]);
  });

  it("concurrent rateLimited calls from several processes apply one decrease per cooldown", async () => {
    const root = tempDir();
    const script = childScript(
      root,
      `const { createFsLimiter } = await import(${JSON.stringify(STORE_MODULE)});
       const limiter = createFsLimiter(root, { min: 1, max: 8, decreaseFactor: 0.5, cooldownMs: 60000, increaseAfterMs: 120000 });
       await startTogether(root);
       await limiter.rateLimited(1000 + Math.floor(Math.random() * 100));
       await limiter.rateLimited(70000 + Math.floor(Math.random() * 100));
       report({ done: true });`,
    );

    const reports = await runTogether(root, script, [], 6);

    expect(reports).toHaveLength(6);
    const state = JSON.parse(readFileSync(join(root, "limiter.json"), "utf8"));
    expect(state.cap).toBe(2);
    expect(state.lastDecreaseAt).toBeGreaterThanOrEqual(70_000);
    expect(readdirSync(root).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
  }, 60_000);
});
