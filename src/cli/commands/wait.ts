import { followJob } from "../../app/follow.ts";
import { renderSummary } from "../../render/index.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";
import { untilInterrupted } from "../interrupt.ts";

export const waitCommand: Command = {
  name: "wait",
  synopsis: ["wait <id> [--json]"],
  options: {},
  async run(call) {
    const [id] = call.positionals;
    if (id === undefined) return call.usage("wait needs a job id");
    return followAndReport(call, id);
  },
};

/**
 * Follows a job a detached driver works until it lands, then prints its summary (exit 0 on pass, 3 otherwise).
 * SIGINT/SIGTERM only end the follow (exit 130); a job no live driver will finish exits 6 (not ready: it needs
 * /zai:stop or /zai:discard). The job itself is never touched.
 */
export async function followAndReport(call: Invocation, id: string): Promise<ExitCode> {
  const followed = await untilInterrupted((signal) => followJob(call.deps, id, signal));
  if (!followed.ok) return call.fail(followed.error);
  const { kind, job } = followed.value;
  if (call.flag("json")) call.json(job);
  switch (kind) {
    case "landed":
      if (!call.flag("json")) call.deps.out.line(renderSummary(job));
      return job.attempts.at(-1)?.verdict === "pass" ? EXIT.ok : EXIT.notPass;
    case "stale":
      call.deps.out.error(
        `zai: job ${job.id} is ${job.state} but has no live driver; /zai:stop ${job.id} moves it to review, /zai:discard ${job.id} drops it.`,
      );
      return EXIT.notReady;
    case "detached":
      call.deps.out.error(
        `zai job ${job.id} keeps running detached: /zai:wait ${job.id} follows it again, /zai:stop ${job.id} stops it.`,
      );
      return EXIT.interrupted;
  }
}
