import type { Deps } from "../app/deps.ts";
import type { AppError } from "../app/errors.ts";
import { describeError, exitFor } from "./errors.ts";
import type { ExitCode } from "./exit.ts";

export type OptionSpec = { readonly type: "boolean" } | { readonly type: "string" };

/** What a command sees: parsed flags and positionals, the deps, the caller's cwd. */
export interface Invocation {
  readonly deps: Deps;
  readonly cwd: string;
  readonly positionals: readonly string[];
  flag(name: string): boolean;
  text(name: string): string | undefined;
  /** `zai: <message>` and the command's synopsis on stderr; exit 2. */
  usage(message: string): ExitCode;
  /** `zai: <describeError>` on stderr; the error's exit code. */
  fail(error: AppError): ExitCode;
  /** JSON on stdout. */
  json(value: unknown): void;
}

export interface Command {
  readonly name: string;
  /** Synopsis lines without the leading `zai `. */
  readonly synopsis: readonly string[];
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** Internal entry points stay out of help. */
  readonly hidden?: boolean;
  run(call: Invocation): Promise<ExitCode>;
}

export function usageLines(command: Command): readonly string[] {
  return command.synopsis.map((line, i) => `${i === 0 ? "usage:" : "      "} zai ${line}`);
}

export function failWith(deps: Deps, error: AppError): ExitCode {
  deps.out.error(`zai: ${describeError(error)}`);
  return exitFor(error);
}
