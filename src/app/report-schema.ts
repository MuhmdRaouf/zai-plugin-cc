import { readFile } from "node:fs/promises";
import type { Brief } from "../domain/brief.ts";
import { builtinJsonSchema } from "../domain/reports.ts";
import { err, ok, type Result } from "../domain/result.ts";

/** The JSON schema the worker's report must follow (`--json-schema`): a built-in, or the brief's schema file, which
 *  must hold a JSON object in draft-07 or with no `$schema`. */
export async function reportSchema(
  report: Brief["report"],
): Promise<Result<Record<string, unknown>, string>> {
  if (report.kind === "builtin") return ok(builtinJsonSchema(report.name));
  let text: string;
  try {
    text = await readFile(report.path, "utf8");
  } catch (error) {
    return err(`cannot read ${report.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = parseJson(text);
  if (!isObject(value)) return err(`${report.path} must hold a JSON schema object`);
  const declared = value.$schema;
  if (declared !== undefined && declared !== DRAFT_07) {
    return err(
      `${report.path} declares $schema ${JSON.stringify(declared)}; claude --json-schema accepts only draft-07 (${DRAFT_07}) or no $schema`,
    );
  }
  return ok(value);
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
