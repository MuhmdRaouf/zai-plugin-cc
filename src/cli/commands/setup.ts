import { describeWorkerError } from "../../app/errors.ts";
import { ping } from "../../app/ping.ts";
import { MODELS } from "../../domain/model.ts";
import type { Result } from "../../domain/result.ts";
import { outcomeText, plural, usd } from "../../render/format.ts";
import type { Command, Invocation } from "../command.ts";
import { EXIT } from "../exit.ts";

type Check = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string };

interface SetupReport {
  readonly ready: boolean;
  readonly claude: Check & { readonly bin: string };
  readonly key: Check;
  readonly state: string;
  readonly cap: { readonly now: number; readonly max: number };
  readonly ping?: Check;
}

export const setupCommand: Command = {
  name: "setup",
  synopsis: ["setup [--ping] [--json]"],
  options: { ping: { type: "boolean" } },
  async run(call) {
    const report = await setupReport(call);
    if (call.flag("json")) call.json(report);
    else call.deps.out.line(renderSetup(report));
    return report.ready ? EXIT.ok : EXIT.notReady;
  },
};

function check<E>(result: Result<string, E>, describe: (error: E) => string): Check {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: describe(result.error) };
}

async function setupReport(call: Invocation): Promise<SetupReport> {
  const { deps } = call;
  const claude = check(await deps.host.claudeVersion(), (error) => error);
  const key = check(await deps.host.keySource(), describeWorkerError);
  const cap = { now: await deps.limiter.capacity(deps.clock.now()), max: deps.config.limiter.max };
  const base = { claude: { ...claude, bin: deps.host.claudeBin }, key, state: deps.host.stateRoot, cap };
  if (!call.flag("ping") || !claude.ok || !key.ok) return { ready: claude.ok && key.ok, ...base };
  const pinged = await pingCheck(call);
  return { ready: pinged.ok, ...base, ping: pinged };
}

async function pingCheck(call: Invocation): Promise<Check> {
  const result = await ping(call.deps);
  if (!result.ok) return { ok: false, error: describeWorkerError(result.error) };
  const { outcome, usage } = result.value;
  if (outcome.kind !== "completed") return { ok: false, error: outcomeText(outcome) };
  return {
    ok: true,
    value: `${MODELS.flash.zaiId} answered (${plural(usage.turns, "turn")}, ${usd(usage.costUsd)})`,
  };
}

function renderSetup(report: SetupReport): string {
  const line = (label: string, text: string) => `  ${`${label}:`.padEnd(8)}${text}`;
  const claude = report.claude.ok
    ? `${report.claude.bin} (${report.claude.value})`
    : `${report.claude.bin}: FAILED: ${report.claude.error}`;
  const key = report.key.ok ? `present (${report.key.value})` : `MISSING: ${report.key.error}`;
  const ping =
    report.ping === undefined
      ? []
      : [line("ping", report.ping.ok ? `ok: ${report.ping.value}` : `FAILED: ${report.ping.error}`)];
  return [
    "zai setup",
    line("claude", claude),
    line("key", key),
    line("state", report.state),
    line("cap", `${report.cap.now} concurrent workers now (at most ${report.cap.max})`),
    ...ping,
    report.ready ? "ready" : "not ready",
  ].join("\n");
}
