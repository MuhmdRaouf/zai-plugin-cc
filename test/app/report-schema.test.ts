import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportSchema } from "../../src/app/report-schema.ts";

async function schemaFile(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "zai-schema-")), "report.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("reportSchema", () => {
  it("returns a built-in as draft-07", async () => {
    const result = await reportSchema({ kind: "builtin", name: "sweep" });
    expect(result.ok && result.value.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("accepts a schema file with no $schema or a draft-07 one", async () => {
    for (const $schema of [undefined, "http://json-schema.org/draft-07/schema#"]) {
      const path = await schemaFile({ $schema, type: "object" });
      expect((await reportSchema({ kind: "file", path })).ok).toBe(true);
    }
  });

  it("rejects a schema file declaring another draft, before any worker starts (claude --json-schema would crash)", async () => {
    const path = await schemaFile({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    });
    expect(await reportSchema({ kind: "file", path })).toEqual({
      ok: false,
      error: expect.stringContaining("draft-07"),
    });
  });
});
