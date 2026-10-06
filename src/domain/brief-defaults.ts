import type { Brief, BuiltinReport, Mode } from "./brief.ts";
import type { FrontMatter } from "./brief-schema.ts";
import type { ModelTier } from "./model.ts";

export const DEFAULT_TIMEOUT_MS = 2 * 3_600_000;
export const DEFAULT_BASE = "HEAD";
export const DEFAULT_RETRIES = { fix: 1, infra: 2 } as const;
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_MODEL: Readonly<Record<Mode, ModelTier>> = {
  edit: "glm",
  exec: "flash",
  readonly: "flash",
};
export const DEFAULT_REPORT: Readonly<Record<Mode, BuiltinReport>> = {
  edit: "change",
  exec: "sweep",
  readonly: "notes",
};
export const DEFAULT_SCOPE: Readonly<Record<Mode, readonly string[]>> = {
  edit: ["**"],
  exec: [],
  readonly: [],
};

/** Fill the defaults that depend on the mode (and the caller's directory). */
export function withDefaults(fields: FrontMatter, body: string, defaultCwd: string): Brief {
  const { mode, effort, budgetUsd } = fields;
  return {
    title: fields.title,
    body,
    model: fields.model ?? DEFAULT_MODEL[mode],
    ...(effort === undefined ? {} : { effort }),
    mode,
    cwd: fields.cwd ?? defaultCwd,
    base: fields.base,
    scope: fields.scope ?? DEFAULT_SCOPE[mode],
    forbid: fields.forbid,
    gates: fields.gates,
    timeoutMs: fields.timeout,
    retries: fields.retries,
    report: fields.report ?? { kind: "builtin", name: DEFAULT_REPORT[mode] },
    addDirs: fields.addDirs,
    env: fields.env,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    tags: fields.tags,
  };
}
