import { parseDocument } from "yaml";
import { withDefaults } from "./brief-defaults.ts";
import { splitFrontMatter } from "./brief-front-matter.ts";
import { frontMatterSchema, requiredMessage, toBriefErrors } from "./brief-schema.ts";
import { renderBriefTemplate } from "./brief-template.ts";
import type { ModelTier } from "./model.ts";
import { err, ok, type Result } from "./result.ts";

export { parseDuration } from "./brief-duration.ts";

export type Mode = "edit" | "exec" | "readonly";
export type Effort = "low" | "medium" | "high";
export type BuiltinReport = "change" | "sweep" | "notes";

export interface Gate {
  readonly run: string;
  /** Milliseconds; default 10 minutes. */
  readonly timeoutMs: number;
}

export interface Brief {
  readonly title: string;
  readonly body: string;
  readonly model: ModelTier;
  readonly effort?: Effort;
  readonly mode: Mode;
  /** Absolute repository path (resolved by the caller from `cwd` or the current git root). */
  readonly cwd: string;
  readonly base: string;
  readonly scope: readonly string[];
  readonly forbid: readonly string[];
  readonly gates: readonly Gate[];
  readonly timeoutMs: number;
  readonly retries: { readonly fix: number; readonly infra: number };
  readonly report:
    | { readonly kind: "builtin"; readonly name: BuiltinReport }
    | { readonly kind: "file"; readonly path: string };
  readonly addDirs: readonly string[];
  /** Names only. Values are read from the orchestrator's environment at run time and never persisted. */
  readonly env: readonly string[];
  readonly budgetUsd?: number;
  readonly tags: readonly string[];
}

export interface BriefContext {
  /** Absolute path used when the front matter has no `cwd`, and to resolve a relative one. */
  readonly defaultCwd: string;
}

export type BriefError =
  | { readonly kind: "no_front_matter" }
  | { readonly kind: "yaml"; readonly message: string }
  | { readonly kind: "field"; readonly field: string; readonly message: string }
  | { readonly kind: "empty_body" };

/** Parse a brief document (YAML front matter + markdown body) and apply mode-dependent defaults. */
export function parseBrief(text: string, ctx: BriefContext): Result<Brief, readonly BriefError[]> {
  const document = splitFrontMatter(text);
  if (document === null) return err([{ kind: "no_front_matter" }]);
  const yaml = parseDocument(document.frontMatter);
  if (yaml.errors.length > 0)
    return err(yaml.errors.map((error) => ({ kind: "yaml", message: error.message })));
  const data: unknown = yaml.toJS();
  const fields = frontMatterSchema(ctx.defaultCwd).safeParse(data ?? {}, { error: requiredMessage });
  const errors: BriefError[] = fields.success ? [] : [...toBriefErrors(fields.error)];
  if (document.body.trim() === "") errors.push({ kind: "empty_body" });
  if (!fields.success || errors.length > 0) return err(errors);
  return ok(withDefaults(fields.data, document.body, ctx.defaultCwd));
}

/** A front-matter template for `zai brief new`, with every field documented as a comment. */
export function briefTemplate(title: string, mode: Mode): string {
  return renderBriefTemplate(title, mode);
}
