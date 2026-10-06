import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Persists the rename itself (the directory entry); best effort where directories cannot be fsynced. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch {
    // Not supported on this platform/filesystem; the rename is still atomic, just not yet durable.
  } finally {
    await handle.close();
  }
}

/** Readers see the old file or the new one, never a torn one: write `<path>.<pid>.tmp`, fsync, rename over path.
 *  The caller serialises writers of the same path (the tmp name is per process). */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await syncDirectory(dirname(path));
}
