import { resolve } from "node:path";
import { z } from "zod";
import type { Brief, BriefError, BuiltinReport } from "./brief.ts";
import {
  DEFAULT_BASE,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "./brief-defaults.ts";
import { parseDuration } from "./brief-duration.ts";
import { MODELS, type ModelTier } from "./model.ts";

/** A tier is named by itself or by its Z.ai model id. */
const TIER_BY_NAME: ReadonlyMap<string, ModelTier> = new Map(
  Object.values(MODELS).flatMap((spec) => [
    [spec.tier, spec.tier],
    [spec.zaiId, spec.tier],
  ]),
);

const BUILTIN_REPORTS: readonly BuiltinReport[] = ["change", "sweep", "notes"];

const text = z.string().trim().min(1, "must not be empty");

const duration = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const parsed = parseDuration(value);
  if (parsed.ok) return parsed.value;
  ctx.addIssue(parsed.error);
  return z.NEVER;
});

const gate = z.preprocess(
  (value) => (typeof value === "string" ? { run: value } : value),
  z
    .strictObject({ run: text, timeout: duration.optional() })
    .transform(({ run, timeout }) => ({ run, timeoutMs: timeout ?? DEFAULT_GATE_TIMEOUT_MS })),
);

const count = z.int().min(0);

const model = text.transform((name, ctx) => {
  const tier = TIER_BY_NAME.get(name);
  if (tier !== undefined) return tier;
  ctx.addIssue(`must be one of ${[...TIER_BY_NAME.keys()].join(", ")}`);
  return z.NEVER;
});

/** Front-matter fields validated and normalised, with mode-independent defaults; the rest depend on the mode. */
export function frontMatterSchema(defaultCwd: string) {
  const path = text.transform((value) => resolve(defaultCwd, value));
  const report = text.transform((value, ctx) => {
    const contract = reportContract(value, defaultCwd);
    if (contract !== null) return contract;
    ctx.addIssue("must be change, sweep, notes or a path to a .json schema");
    return z.NEVER;
  });
  return z.strictObject({
    title: text,
    model: model.optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    mode: z.enum(["edit", "exec", "readonly"]).default("edit"),
    cwd: path.optional(),
    base: text.default(DEFAULT_BASE),
    scope: z.array(text).optional(),
    forbid: z.array(text).default([]),
    gates: z.array(gate).default([]),
    timeout: duration.default(DEFAULT_TIMEOUT_MS),
    retries: z
      .strictObject({ fix: count.default(DEFAULT_RETRIES.fix), infra: count.default(DEFAULT_RETRIES.infra) })
      .default(DEFAULT_RETRIES),
    report: report.optional(),
    addDirs: z.array(path).default([]),
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a shell variable name")).default([]),
    budgetUsd: z.number().positive().optional(),
    tags: z.array(text).default([]),
  });
}

export type FrontMatter = z.output<ReturnType<typeof frontMatterSchema>>;

function reportContract(value: string, defaultCwd: string): Brief["report"] | null {
  if (isBuiltinReport(value)) return { kind: "builtin", name: value };
  if (value.endsWith(".json")) return { kind: "file", path: resolve(defaultCwd, value) };
  return null;
}

function isBuiltinReport(value: string): value is BuiltinReport {
  return BUILTIN_REPORTS.some((name) => name === value);
}

/** Every zod issue as a field error; an unknown key becomes one error naming that key. */
export function toBriefErrors(error: z.ZodError): readonly BriefError[] {
  return error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => fieldError([...issue.path, key], "unknown field"))
      : [fieldError(issue.path, issue.message)],
  );
}

function fieldError(path: readonly PropertyKey[], message: string): BriefError {
  return { kind: "field", field: path.length === 0 ? "front matter" : path.map(String).join("."), message };
}

/** Missing fields read "required" instead of zod's "expected string, received undefined". */
export const requiredMessage: z.core.$ZodErrorMap = (issue) =>
  issue.input === undefined ? "required" : undefined;
