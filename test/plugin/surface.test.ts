import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginRoot = join(repoRoot, "plugins/zai");

const AGENT_NAMES = ["glm", "glm-flash"] as const;
const AGENT_TOOLS = ["Bash", "Read", "Write", "Glob", "Grep"];
const AGENT_COLORS = ["blue", "cyan", "green", "yellow", "magenta", "red"] as const;
const SKILL_DIR = "skills/zai-loop";
const SKILL_REFERENCES = ["references/brief-guide.md", "references/review-checklist.md"];
/** Flags the plugin surface uses before the CLI slice that implements them lands. */
const PENDING_FLAGS: Readonly<Record<string, readonly string[]>> = {};
const GLOBAL_FLAGS = ["--json"];
const INTERNAL_COMMANDS = ["drive"];
/** The only commands a dispatcher may run: acceptance decisions belong to the orchestrator. */
const DISPATCHER_COMMANDS = ["brief", "run", "wait", "board"];

const CLI_INVOCATION = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/zai\.js" ([a-z]+)([^`\n]*)/g;

function readPluginFile(relative: string): string {
  return readFileSync(join(pluginRoot, relative), "utf8");
}

/** The file's text as its consumer sees it: JSON string escapes (`\"`) undone. */
function surfaceText(relative: string): string {
  const text = readPluginFile(relative);
  return relative.endsWith(".json") ? text.replaceAll('\\"', '"') : text;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(join(pluginRoot, dir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `${dir}/${name}`)
    .sort();
}

function surfaceMarkdown(): string[] {
  return [...markdownFiles("agents"), ...markdownFiles("commands"), `${SKILL_DIR}/SKILL.md`];
}

function allSurfaceFiles(): string[] {
  return [...surfaceMarkdown(), ...SKILL_REFERENCES.map((ref) => `${SKILL_DIR}/${ref}`), "hooks/hooks.json"];
}

interface FrontMatterDoc {
  readonly data: unknown;
  readonly body: string;
}

function splitFrontMatter(text: string): FrontMatterDoc | undefined {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return undefined;
  return { data: parseYaml(match[1] ?? ""), body: match[2] ?? "" };
}

function frontMatterOf(relative: string): FrontMatterDoc {
  const doc = splitFrontMatter(readPluginFile(relative));
  if (doc === undefined) throw new Error(`${relative}: no front matter`);
  return doc;
}

/**
 * Parses the `Commands` doc comment of src/cli/run.ts into command → documented flags. A line holds one or more
 * segments separated by 3+ spaces; a segment is a command synopsis when it starts with `name`, optionally a
 * subcommand word, then an argument (`<…>`, `[…]`) or nothing. Other segments are descriptions.
 */
function cliSynopsis(): Map<string, Set<string>> {
  const source = readFileSync(join(repoRoot, "src/cli/run.ts"), "utf8");
  const block = /Commands[^\n]*:\n([\s\S]*?)\n\s*\* Exit codes/.exec(source)?.[1] ?? "";
  const synopsis = new Map<string, Set<string>>();
  for (const line of block.split("\n")) {
    for (const segment of line.replace(/^\s*\*\s*/, "").split(/\s{3,}/)) {
      const command = /^([a-z]+)(?: [a-z]+)?(?: [<[]|$)/.exec(segment)?.[1];
      if (command === undefined) continue;
      const flags = synopsis.get(command) ?? new Set<string>();
      for (const flag of segment.match(/--[a-z][a-z-]*/g) ?? []) flags.add(flag);
      synopsis.set(command, flags);
    }
  }
  return synopsis;
}

interface Invocation {
  readonly file: string;
  readonly command: string;
  readonly flags: readonly string[];
}

function invocationsIn(file: string): Invocation[] {
  return [...surfaceText(file).matchAll(CLI_INVOCATION)].map((match) => ({
    file,
    command: match[1] ?? "",
    flags: (match[2] ?? "").match(/--[a-z][a-z-]*/g) ?? [],
  }));
}

function toolList(tools: string | readonly string[]): string[] {
  return typeof tools === "string" ? tools.split(",").map((tool) => tool.trim()) : [...tools];
}

const toolsField = z.union([z.string(), z.array(z.string())]);

const AgentFrontMatter = z
  .object({
    name: z.string(),
    description: z.string(),
    model: z.string(),
    color: z.enum(AGENT_COLORS),
    tools: toolsField,
  })
  .strict();

const CommandFrontMatter = z
  .object({
    description: z.string().min(1),
    "allowed-tools": toolsField,
    "argument-hint": z.string().optional(),
    "disable-model-invocation": z.boolean().optional(),
  })
  .strict();

const SkillFrontMatter = z
  .object({ name: z.string(), description: z.string().min(1).max(1024), version: z.string().optional() })
  .strict();

const HooksFile = z
  .object({
    description: z.string().optional(),
    hooks: z.record(
      z.string(),
      z.array(
        z
          .object({
            matcher: z.string().optional(),
            hooks: z.array(
              z
                .object({ type: z.literal("command"), command: z.string(), timeout: z.number().optional() })
                .strict(),
            ),
          })
          .strict(),
      ),
    ),
  })
  .strict();

describe("plugin surface", () => {
  it("parses the CLI synopsis in src/cli/run.ts into the documented command set", () => {
    const synopsis = cliSynopsis();

    expect([...synopsis.keys()].sort()).toEqual(
      [
        "accept",
        "batch",
        "board",
        "brief",
        "discard",
        "drive",
        "return",
        "review",
        "run",
        "setup",
        "show",
        "stop",
        "usage",
        "wait",
      ].sort(),
    );
    expect([...(synopsis.get("run") ?? [])].sort()).toEqual(["--bg", "--flash", "--mode", "--wait"]);
  });

  it("every agent, command and skill markdown file has YAML front matter (a mapping) and a non-empty body", () => {
    for (const file of surfaceMarkdown()) {
      const doc = splitFrontMatter(readPluginFile(file));

      expect(doc, `${file}: front matter`).toBeDefined();
      expect(z.record(z.string(), z.unknown()).safeParse(doc?.data).success, `${file}: mapping`).toBe(true);
      expect(doc?.body.trim().length ?? 0, `${file}: body`).toBeGreaterThan(0);
    }
  });

  it("agents glm and glm-flash: name matches the file, model sonnet, the dispatcher tools, distinct colors, triggering examples", () => {
    expect(markdownFiles("agents")).toEqual(AGENT_NAMES.map((name) => `agents/${name}.md`).sort());
    const colors = new Set<string>();
    for (const name of AGENT_NAMES) {
      const fm = AgentFrontMatter.parse(frontMatterOf(`agents/${name}.md`).data);

      expect(fm.name).toBe(name);
      expect(fm.model).toBe("sonnet");
      expect(toolList(fm.tools).sort()).toEqual([...AGENT_TOOLS].sort());
      expect(fm.description).toMatch(/^Use this agent when/);
      expect(fm.description.match(/<example>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      colors.add(fm.color);
    }
    expect(colors.size).toBe(AGENT_NAMES.length);
  });

  it("agents run the job with run --wait in the background and never call acceptance commands", () => {
    for (const name of AGENT_NAMES) {
      const file = `agents/${name}.md`;
      const invocations = invocationsIn(file);

      expect(readPluginFile(file)).toContain("run_in_background");
      expect(invocations.some((call) => call.command === "run" && call.flags.includes("--wait"))).toBe(true);
      expect(
        invocations.map((call) => call.command).filter((cmd) => !DISPATCHER_COMMANDS.includes(cmd)),
      ).toEqual([]);
    }
  });

  it("agents re-attach with wait <id> when the background command dies, and never re-run the brief", () => {
    for (const name of AGENT_NAMES) {
      const file = `agents/${name}.md`;
      const text = readPluginFile(file);

      expect(invocationsIn(file).some((call) => call.command === "wait")).toBe(true);
      expect(text).toMatch(/[Nn]ever re-run `run`/);
    }
  });

  it("has exactly one command file per user-facing CLI command (all but the internal drive)", () => {
    const userFacing = [...cliSynopsis().keys()].filter((cmd) => !INTERNAL_COMMANDS.includes(cmd));

    expect(markdownFiles("commands")).toEqual(userFacing.map((cmd) => `commands/${cmd}.md`).sort());
  });

  it("every command declares a description and allowed-tools Bash(node:*), and invokes its own CLI command", () => {
    for (const file of markdownFiles("commands")) {
      const fm = CommandFrontMatter.parse(frontMatterOf(file).data);
      const command = basename(file, ".md");

      expect(toolList(fm["allowed-tools"]), file).toEqual(["Bash(node:*)"]);
      expect(
        invocationsIn(file).some((call) => call.command === command),
        `${file} invokes ${command}`,
      ).toBe(true);
    }
  });

  it("every CLI invocation, hooks and skill references included, names a documented command with documented flags", () => {
    const synopsis = cliSynopsis();
    const invocations = allSurfaceFiles().flatMap(invocationsIn);

    expect(invocations.length).toBeGreaterThan(0);
    for (const call of invocations) {
      const documented = synopsis.get(call.command);
      const allowed = [...(documented ?? []), ...GLOBAL_FLAGS, ...(PENDING_FLAGS[call.command] ?? [])];

      expect(documented, `${call.file}: ${call.command} is a CLI command`).toBeDefined();
      expect(INTERNAL_COMMANDS, `${call.file}: ${call.command} is internal`).not.toContain(call.command);
      expect(
        call.flags.filter((flag) => !allowed.includes(flag)),
        `${call.file}: ${call.command} flags`,
      ).toEqual([]);
    }
  });

  it(`every \${CLAUDE_PLUGIN_ROOT} reference is the quoted CLI path "\${CLAUDE_PLUGIN_ROOT}/dist/zai.js"`, () => {
    let total = 0;
    for (const file of allSurfaceFiles()) {
      const text = surfaceText(file);
      const references = text.match(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g) ?? [];
      const canonical = text.match(/"\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/zai\.js"/g) ?? [];

      expect(canonical.length, file).toBe(references.length);
      total += references.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("hooks.json parses and its SessionStart hook runs board --hook with a 5 second timeout", () => {
    const hooks = HooksFile.parse(JSON.parse(readPluginFile("hooks/hooks.json")));
    const sessionStart = (hooks.hooks.SessionStart ?? []).flatMap((group) => group.hooks);

    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart"]);
    expect(sessionStart).toEqual([
      { type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/dist/zai.js" board --hook`, timeout: 5 },
    ]);
  });

  it("skill zai-loop: name matches its directory, third-person description, and links every reference file", () => {
    const { data, body } = frontMatterOf(`${SKILL_DIR}/SKILL.md`);
    const fm = SkillFrontMatter.parse(data);
    const linked = [...new Set(body.match(/references\/[a-z-]+\.md/g) ?? [])].sort();

    expect(fm.name).toBe("zai-loop");
    expect(fm.description).toMatch(/^This skill should be used when/);
    expect(linked).toEqual([...SKILL_REFERENCES].sort());
    for (const ref of SKILL_REFERENCES) {
      expect(readPluginFile(`${SKILL_DIR}/${ref}`).trim().length, ref).toBeGreaterThan(0);
    }
  });
});
