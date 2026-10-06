import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  initialLimiter,
  type LimiterConfig,
  type LimiterState,
  onRateLimited,
  tick,
} from "../domain/limiter.ts";
import type { LimiterStore } from "../ports/index.ts";
import { writeFileAtomic } from "./fs-atomic.ts";
import { waitLock } from "./fs-lock.ts";
import { isAlive } from "./proc-group.ts";

/** The lock is held only for one read-modify-write; waiting longer means its holder is stuck. */
const LOCK_TIMEOUT_MS = 10_000;

const StoredState = z.object({
  cap: z.number().int(),
  lastDecreaseAt: z.number().nullable(),
  quietSince: z.number(),
});

/** <root>/limiter.json, read-modify-write under a lock file; applies domain/limiter.ts. */
export function createFsLimiter(root: string, config: LimiterConfig): LimiterStore {
  const file = join(root, "limiter.json");

  /** A missing or unreadable file starts over at full capacity; a cap from an older [min, max] is clamped. */
  async function read(now: number): Promise<LimiterState> {
    const text = await readFile(file, "utf8").catch(() => "");
    const stored = StoredState.safeParse(parseJson(text));
    if (!stored.success) return initialLimiter(config, now);
    return { ...stored.data, cap: Math.min(config.max, Math.max(config.min, stored.data.cap)) };
  }

  /** Applies step under the lock and persists a changed state. Without the lock (a stuck holder) the shared state is
   *  left alone and the caller sees the step applied to what was read. */
  async function update(now: number, step: (state: LimiterState) => LimiterState): Promise<LimiterState> {
    await mkdir(root, { recursive: true });
    const lock = await waitLock(`${file}.lock`, process.pid, isAlive, LOCK_TIMEOUT_MS);
    try {
      const before = await read(now);
      const after = step(before);
      if (lock.ok && !sameState(before, after)) await writeFileAtomic(file, `${JSON.stringify(after)}\n`);
      return after;
    } finally {
      if (lock.ok) await lock.value();
    }
  }

  return {
    async capacity(now) {
      return (await update(now, (state) => tick(state, config, now))).cap;
    },
    async rateLimited(now) {
      await update(now, (state) => onRateLimited(state, config, now));
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sameState(a: LimiterState, b: LimiterState): boolean {
  return a.cap === b.cap && a.lastDecreaseAt === b.lastDecreaseAt && a.quietSince === b.quietSince;
}
