import { isMap, parseDocument } from "yaml";
import { splitFrontMatter } from "../domain/brief-front-matter.ts";

export interface BriefOverrides {
  readonly model?: "glm" | "flash";
  readonly mode?: "edit" | "exec" | "readonly";
}

/** The brief text with CLI overrides written into its front matter, so parseBrief derives the mode-dependent defaults
 *  (model, scope, report) from the overridden values. A document that does not parse is returned unchanged for
 *  parseBrief to report. */
export function withOverrides(text: string, overrides: BriefOverrides): string {
  const entries = Object.entries(overrides).filter(([, value]) => value !== undefined);
  const document = splitFrontMatter(text);
  if (entries.length === 0 || document === null) return text;
  const yaml = parseDocument(document.frontMatter);
  if (yaml.errors.length > 0 || !isMap(yaml.contents)) return text;
  for (const [key, value] of entries) yaml.set(key, value);
  return `---\n${yaml.toString()}---\n${document.body}`;
}
