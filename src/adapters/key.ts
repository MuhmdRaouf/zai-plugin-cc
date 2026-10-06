import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../domain/result.ts";
import type { WorkerError } from "../ports/index.ts";
import { errorCode } from "./proc-error.ts";

export const KEY_FILE = "~/.config/zai-plugin-cc/env";

const KEY_LINE = /^(?:export\s+)?ZAI_API_KEY\s*=\s*(.*)$/;

/** ZAI_API_KEY from env wins; else the env file (line `ZAI_API_KEY=...`, optional quotes, comments ignored), which must
 *  be mode 0600 or stricter; else no_key. The key is returned, never logged. */
export async function loadKey(
  env: Readonly<Record<string, string | undefined>>,
  path: string,
): Promise<Result<string, WorkerError>> {
  const fromEnv = env.ZAI_API_KEY?.trim();
  if (fromEnv) return ok(fromEnv);
  const file = expandHome(path, env.HOME ?? homedir());
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    return err(readFailure(file, error));
  }
  try {
    return await readKeyFrom(handle, file);
  } catch (error) {
    return err(readFailure(file, error));
  } finally {
    await handle.close();
  }
}

/** One descriptor serves the mode check and the read, so the file cannot be swapped in between. */
async function readKeyFrom(handle: FileHandle, file: string): Promise<Result<string, WorkerError>> {
  const { mode } = await handle.stat();
  if ((mode & 0o077) !== 0) return err({ kind: "insecure_key_file", path: file, mode: formatMode(mode) });
  const key = parseKeyFile(await handle.readFile("utf8"));
  return key ? ok(key) : err(noKey(file));
}

function parseKeyFile(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const match = KEY_LINE.exec(line.trim());
    if (match?.[1] !== undefined) return unquote(match[1].trim());
  }
  return undefined;
}

function unquote(value: string): string {
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
  return quoted ? value.slice(1, -1) : value;
}

function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

function readFailure(file: string, error: unknown): WorkerError {
  const code = errorCode(error);
  if (code === "ENOENT") return noKey(file);
  return { kind: "no_key", message: `cannot read Z.ai key file ${file} (${code ?? "unknown error"})` };
}

function noKey(file: string): WorkerError {
  return {
    kind: "no_key",
    message: `no Z.ai key: export ZAI_API_KEY, or put ZAI_API_KEY=<key> in ${file} (chmod 600)`,
  };
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}
