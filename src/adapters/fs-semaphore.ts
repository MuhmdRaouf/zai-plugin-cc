import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Semaphore } from "../ports/index.ts";
import { errnoCode } from "./fs-errors.ts";
import { createHolding, type IsAlive, type Release, readHolder, release, waitLock } from "./fs-lock.ts";

const POLL_MS = 2000;
/** The mutex is held only to count and create slots; this long means its holder is stuck, so retry next poll. */
const MUTEX_TIMEOUT_MS = 10_000;
const SLOT = ".slot";

interface Slot {
  readonly jobId: string;
  readonly pid: number | null;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** <root>/slots/<jobId>.slot created exclusively (complete with its pid, or not at all); stale holders (dead pid) are
 *  reclaimed; polls every 2 s.
 *  Counting and creating slots happen under one mutex file, so processes racing for the last slot cannot both win. */
export function createFsSemaphore(
  root: string,
  capacity: () => Promise<number>,
  isAlive: IsAlive,
  sleep: Sleep,
): Semaphore {
  const dir = join(root, "slots");
  const slotPath = (jobId: string) => join(dir, `${jobId}${SLOT}`);
  const live = (slot: Slot): slot is { readonly jobId: string; readonly pid: number } =>
    slot.pid !== null && isAlive(slot.pid);

  async function slots(): Promise<Slot[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [];
      throw error;
    }
    const found = await Promise.all(
      names
        .filter((name) => name.endsWith(SLOT))
        .sort()
        .map(async (name) => ({
          jobId: name.slice(0, -SLOT.length),
          pid: await readHolder(join(dir, name)),
        })),
    );
    // undefined: released between readdir and read.
    return found.flatMap(({ jobId, pid }) => (pid === undefined ? [] : [{ jobId, pid }]));
  }

  /** One round under the mutex: drop dead holders' slots, then take one if the current capacity allows. */
  async function tryAcquire(holder: {
    readonly jobId: string;
    readonly pid: number;
  }): Promise<Release | null> {
    await mkdir(dir, { recursive: true });
    const mutex = await waitLock(join(dir, ".mutex"), holder.pid, isAlive, MUTEX_TIMEOUT_MS);
    if (!mutex.ok) return null;
    try {
      const current = await slots();
      for (const stale of current.filter((slot) => !live(slot)))
        await rm(slotPath(stale.jobId), { force: true });
      const held = current.filter(live);
      if (held.length >= (await capacity()) || held.some((slot) => slot.jobId === holder.jobId)) return null;
      const path = slotPath(holder.jobId);
      return (await createHolding(path, holder.pid)) ? () => release(path, holder.pid) : null;
    } finally {
      await mutex.value();
    }
  }

  return {
    async acquire(holder, signal) {
      for (;;) {
        signal?.throwIfAborted();
        const slot = await tryAcquire(holder);
        if (slot !== null) {
          if (!signal?.aborted) return slot;
          // Aborted while the round ran: give the slot straight back so an aborted acquire holds nothing.
          await slot();
          signal.throwIfAborted();
        }
        await sleep(POLL_MS, signal).catch((error: unknown) => {
          // Reject with the caller's abort reason whatever the injected sleep rejects with.
          signal?.throwIfAborted();
          throw error;
        });
      }
    },
    async held() {
      return (await slots()).filter(live).map(({ jobId, pid }) => ({ jobId, pid }));
    },
  };
}
