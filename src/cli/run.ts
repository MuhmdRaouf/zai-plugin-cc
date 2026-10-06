import type { Deps } from "../app/deps.ts";
import { parse } from "./args.ts";
import { type Command, failWith, type Invocation, usageLines } from "./command.ts";
import { batchCommand } from "./commands/batch.ts";
import { briefCommand } from "./commands/brief.ts";
import { acceptCommand, discardCommand, returnCommand, stopCommand } from "./commands/decide.ts";
import { boardCommand, reviewCommand, showCommand, usageCommand } from "./commands/queries.ts";
import { driveCommand, runCommand } from "./commands/run.ts";
import { setupCommand } from "./commands/setup.ts";
import { waitCommand } from "./commands/wait.ts";
import { EXIT, type ExitCode } from "./exit.ts";

export { EXIT, type ExitCode } from "./exit.ts";

const COMMANDS: readonly Command[] = [
  runCommand,
  waitCommand,
  batchCommand,
  boardCommand,
  showCommand,
  reviewCommand,
  acceptCommand,
  returnCommand,
  discardCommand,
  stopCommand,
  usageCommand,
  setupCommand,
  briefCommand,
  driveCommand,
];

const COMMON = { json: { type: "boolean" }, help: { type: "boolean" } } as const;

/**
 * Commands (all accept --json for machine output):
 *   run <brief.md|-> [--flash] [--mode edit|exec|readonly] [--wait|--bg]   submit, detached driver (--wait follows it)
 *   wait <id>                                                              follow a job to review (Ctrl-C only detaches)
 *   batch <dir|glob|manifest.txt>                                          submit many, detached drivers
 *   drive <id>                                                             internal: detached driver entry
 *   board [--all] [--hook]   show <id> [--follow]   review <id> [--diff]
 *   accept <id> [--no-commit] [--force] [--no-verify]   return <id> <feedback…>   discard <id> [--reason <text>]
 *   stop <id|--all>   usage [--all]   setup [--ping]   brief new <title> [--mode]   brief lint <path>
 * Exit codes per EXIT; usage errors print the command's synopsis.
 */
export async function runCli(argv: readonly string[], deps: Deps, cwd: string): Promise<ExitCode> {
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    for (const line of synopsis()) deps.out.line(line);
    return EXIT.ok;
  }
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    deps.out.error(name === undefined ? "zai: which command?" : `zai: unknown command "${name}"`);
    for (const line of synopsis()) deps.out.error(line);
    return EXIT.usage;
  }
  try {
    return await invoke(command, rest, deps, cwd);
  } catch (error) {
    deps.out.error(`zai: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.unexpected;
  }
}

function synopsis(): readonly string[] {
  const lines = COMMANDS.filter((command) => command.hidden !== true).flatMap((command) =>
    command.synopsis.map((line) => `  zai ${line}`),
  );
  return ["usage:", ...lines];
}

async function invoke(command: Command, argv: readonly string[], deps: Deps, cwd: string): Promise<ExitCode> {
  const usage = (message: string): ExitCode => {
    deps.out.error(`zai: ${message}`);
    for (const line of usageLines(command)) deps.out.error(line);
    return EXIT.usage;
  };
  const parsed = parse(argv, { ...command.options, ...COMMON });
  if (!parsed.ok) return usage(parsed.error);
  const { values, positionals } = parsed.value;
  if (values.help === true) {
    for (const line of usageLines(command)) deps.out.line(line);
    return EXIT.ok;
  }
  const call: Invocation = {
    deps,
    cwd,
    positionals,
    flag: (flag) => values[flag] === true,
    text: (option) => {
      const value = values[option];
      return typeof value === "string" ? value : undefined;
    },
    usage,
    fail: (error) => failWith(deps, error),
    json: (value) => deps.out.line(JSON.stringify(value, null, 2)),
  };
  return command.run(call);
}
