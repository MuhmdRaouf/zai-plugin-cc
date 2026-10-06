import { resolve } from "node:path";
import { drive } from "../../app/drive.ts";
import { submit } from "../../app/submit.ts";
import type { BriefOverrides } from "../../app/submit-overrides.ts";
import type { Job } from "../../domain/job.ts";
import { renderStarted, renderSummary } from "../../render/index.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { untilInterrupted } from "../interrupt.ts";
import { readBrief, readStdin } from "../read.ts";
import { modeOption } from "./mode.ts";
import { followAndReport } from "./wait.ts";

export const runCommand: Command = {
  name: "run",
  synopsis: ["run <brief.md|-> [--flash] [--mode edit|exec|readonly] [--wait|--bg] [--json]"],
  options: {
    flash: { type: "boolean" },
    mode: { type: "string" },
    wait: { type: "boolean" },
    bg: { type: "boolean" },
  },
  async run(call) {
    const [path] = call.positionals;
    if (path === undefined) return call.usage("run needs a brief path (- reads stdin)");
    if (call.flag("wait") && call.flag("bg")) return call.usage("--wait and --bg exclude each other");
    const mode = modeOption(call);
    if (!mode.ok) return call.usage(mode.error);
    const text = await readBrief(path === "-" ? path : resolve(call.cwd, path), readStdin);
    if (!text.ok) return call.fail(text.error);
    const overrides: BriefOverrides = {
      ...(call.flag("flash") ? { model: "flash" } : {}),
      ...(mode.value === undefined ? {} : { mode: mode.value }),
    };
    const job = await submit(call.deps, {
      text: text.value,
      ...(path === "-" ? {} : { sourcePath: resolve(call.cwd, path) }),
      cwd: call.cwd,
      overrides,
    });
    if (!job.ok) return call.fail(job.error);
    if (!call.flag("json")) call.deps.out.line(renderStarted(job.value));
    if (!call.flag("wait")) return detach(call, job.value);
    call.deps.process.spawnDriver(job.value.id);
    return followAndReport(call, job.value.id);
  },
};

function detach(call: Invocation, job: Job): ExitCode {
  call.deps.process.spawnDriver(job.id);
  if (call.flag("json")) call.json(job);
  else
    call.deps.out.line(`Running detached: /zai:board shows it, /zai:review ${job.id} once it awaits review.`);
  return EXIT.ok;
}

export const driveCommand: Command = {
  name: "drive",
  synopsis: ["drive <id>"],
  options: {},
  hidden: true,
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("drive needs a job id");
    const driven = await untilInterrupted((signal) => drive(call.deps, id, signal));
    if (!driven.ok) return call.fail(driven.error);
    call.deps.out.line(renderSummary(driven.value));
    return EXIT.ok;
  },
};
