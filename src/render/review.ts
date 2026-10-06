import type { ReviewPacket } from "../app/queries.ts";
import { reportFacts } from "../app/report-facts.ts";
import type { Attempt, ChangeSet, GateResult, Job, ReportCheck, ScopeCheck, Usage } from "../domain/job.ts";
import { fenced } from "../domain/prompt-fence.ts";
import { attemptSummary } from "../domain/prompt-summary.ts";
import { gateFailed } from "../domain/verify.ts";
import {
  count,
  duration,
  lastAttempt,
  modelId,
  outcomeText,
  plural,
  table,
  usd,
  verdictOf,
} from "./format.ts";

/** Lines of a failing gate's output quoted inline; the full output is in the gate log. */
const TAIL_LINES = 20;
const CHANGES_LISTED = 50;

export function review(packet: ReviewPacket): string {
  const { job } = packet;
  const last = lastAttempt(job);
  return [
    ...header(job, last),
    ...(job.attempts.length > 1
      ? section(
          "Attempts",
          job.attempts.map((attempt) => attemptSummary(attempt)),
        )
      : []),
    ...(last === undefined ? [] : attemptSections(last)),
    ...(packet.diffStat === undefined ? [] : section("Diff stat", packet.diffStat.trimEnd().split("\n"))),
    ...(packet.diff === undefined ? [] : ["", "Diff", fenced(packet.diff, "diff").trimEnd()]),
    ...nextActions(job),
  ].join("\n");
}

function header(job: Job, last: Attempt | undefined): readonly string[] {
  const { workspace } = job;
  const attempt = last === undefined ? "no attempt yet" : `attempt ${last.n} (${last.kind})`;
  const where =
    workspace.worktree === undefined
      ? `repository ${workspace.repoRoot} (must stay unchanged), artifacts ${workspace.artifactsDir}`
      : `worktree ${workspace.worktree} (branch ${workspace.branch ?? "?"}, base ${workspace.baseSha.slice(0, 7)})`;
  return [
    `zai job ${job.id}: ${job.brief.title}`,
    `verdict ${verdictOf(job)} · ${modelId(job)} · ${job.brief.mode} · ${attempt} · ${job.state.replace("_", " ")}`,
    where,
  ];
}

function attemptSections(attempt: Attempt): readonly string[] {
  const worker =
    attempt.outcome === undefined || attempt.outcome.kind === "completed"
      ? []
      : [`Worker: ${outcomeText(attempt.outcome)}`];
  const verification = attempt.verification;
  return [
    ...(worker.length === 0 ? [] : ["", ...worker]),
    ...(verification === undefined
      ? ["", "Not verified yet."]
      : [
          ...reportSection(attempt.report, verification.report),
          ...gatesSection(verification.gates),
          "",
          scopeLine(verification.scope),
          ...changesSection(verification.changes),
        ]),
    ...(attempt.usage === undefined ? [] : ["", usageLine(attempt.usage)]),
  ];
}

function section(title: string, lines: readonly string[]): readonly string[] {
  return ["", title, ...lines.map((line) => `  ${line}`)];
}

function reportSection(report: unknown, check: ReportCheck): readonly string[] {
  if (!check.present) return ["", "Report: missing (the worker ended without a structured report)"];
  const { summary, openItems, testsAdded } = reportFacts(report);
  const tests = testsAdded.length === 0 ? [] : [`Tests added: ${testsAdded.join(", ")}`];
  const problems = check.valid
    ? []
    : ["Invalid against its contract:", ...check.problems.map((problem) => `- ${problem}`)];
  const open =
    openItems.length === 0 ? ["Open items: none"] : ["Open items:", ...openItems.map((item) => `- ${item}`)];
  return section("Report", [summary ?? "(no summary)", ...tests, ...open, ...problems]);
}

function gatesSection(gates: readonly GateResult[]): readonly string[] {
  if (gates.length === 0) return ["", "Gates: none run"];
  const passed = gates.filter((gate) => !gateFailed(gate)).length;
  const rows = table(
    gates.map((gate) => [
      gateFailed(gate) ? "FAIL" : "pass",
      gate.run,
      gateStatus(gate),
      duration(gate.durationMs),
    ]),
  );
  const lines = rows.flatMap((row, i) => {
    const gate = gates[i];
    return gate !== undefined && gateFailed(gate) ? [row, ...tail(gate.tail)] : [row];
  });
  return section(`Gates (${passed}/${gates.length} passed)`, lines);
}

function gateStatus(gate: GateResult): string {
  if (gate.timedOut) return "timed out";
  return gate.exitCode === null ? "killed" : `exit ${gate.exitCode}`;
}

function tail(text: string): readonly string[] {
  const lines = text.trimEnd().split("\n");
  if (text.trim() === "") return ["  | (no output)"];
  return lines.slice(-TAIL_LINES).map((line) => `  | ${line}`.trimEnd());
}

function scopeLine(scope: ScopeCheck): string {
  if (scope.repoChanged) return "Scope: VIOLATED, the repository changed (this job must leave it unchanged)";
  const problems = [
    ...(scope.outOfScope.length === 0 ? [] : [`out of scope: ${scope.outOfScope.join(", ")}`]),
    ...(scope.forbidden.length === 0 ? [] : [`forbidden: ${scope.forbidden.join(", ")}`]),
  ];
  return problems.length === 0 ? "Scope: in scope" : `Scope: VIOLATED, ${problems.join("; ")}`;
}

function changesSection(changes: ChangeSet): readonly string[] {
  const entries = [
    ...changes.added.map((path) => `A ${path}`),
    ...changes.modified.map((path) => `M ${path}`),
    ...changes.deleted.map((path) => `D ${path}`),
    ...changes.untracked.map((path) => `? ${path}`),
  ];
  if (entries.length === 0) return ["Changes: none"];
  const more = entries.length > CHANGES_LISTED ? [`and ${entries.length - CHANGES_LISTED} more`] : [];
  return [
    `Changes (${entries.length}):`,
    ...[...entries.slice(0, CHANGES_LISTED), ...more].map((line) => `  ${line}`),
  ];
}

export function usageLine(usage: Usage): string {
  const parts = [
    plural(usage.turns, "turn"),
    `${count(usage.inputTokens)} in / ${count(usage.outputTokens)} out tokens`,
    `${count(usage.cacheReadTokens)} cache read`,
    usd(usage.costUsd),
    duration(usage.durationMs),
    ...(usage.rateLimitRetries === 0
      ? []
      : [plural(usage.rateLimitRetries, "rate-limit retry", "rate-limit retries")]),
  ];
  return `Usage: ${parts.join(" · ")}`;
}

/** The reviewer's three choices as exact commands; only a job awaiting review has them. */
function nextActions(job: Job): readonly string[] {
  if (job.state !== "awaiting_review")
    return ["", `Not awaiting review (${job.state}); /zai:show ${job.id} follows it.`];
  const pass = lastAttempt(job)?.verdict === "pass";
  return section("Next", [
    pass
      ? `/zai:accept ${job.id}`
      : `/zai:accept ${job.id} --force   (verdict ${verdictOf(job)}: only if you accept it anyway)`,
    `/zai:return ${job.id} <feedback>`,
    `/zai:discard ${job.id} --reason <why>`,
  ]);
}
