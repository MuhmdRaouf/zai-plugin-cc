import { type AppError, describeGitError, describeWorkerError } from "../app/errors.ts";
import type { BriefError } from "../domain/brief.ts";
import type { StoreError } from "../ports/index.ts";
import { EXIT, type ExitCode } from "./exit.ts";

export function describeBriefError(error: BriefError): string {
  switch (error.kind) {
    case "no_front_matter":
      return "no YAML front matter (start the file with ---)";
    case "yaml":
      return `YAML: ${error.message}`;
    case "field":
      return `${error.field}: ${error.message}`;
    case "empty_body":
      return "the body (the task) is empty";
  }
}

function describeStoreError(error: StoreError): string {
  switch (error.kind) {
    case "not_found":
      return `no zai job matches "${error.id}" (zai board lists them)`;
    case "locked":
      return `job ${error.id} is held by the driver with pid ${error.holderPid}`;
    case "version_conflict":
      return `job ${error.id} changed meanwhile; run the command again`;
    case "io":
      return `state store: ${error.message}`;
  }
}

/** One line, no prefix. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "brief":
      return `invalid brief: ${error.errors.map(describeBriefError).join("; ")}`;
    case "brief_unreadable":
      return `cannot read ${error.path}: ${error.message}`;
    case "missing_env":
      return `the brief's env names are not set in this environment: ${error.names.join(", ")}`;
    case "wrong_state":
      return `job ${error.id} is ${error.state}; this needs ${orList(error.allowed)}`;
    case "lifecycle":
      return `job cannot go from ${error.error.from} on ${error.error.event}`;
    case "git":
      return describeGitError(error.error);
    case "store":
      return describeStoreError(error.error);
    case "worker":
      return describeWorkerError(error.error);
    case "empty_feedback":
      return "the feedback must not be empty";
    case "not_pass":
      return `job ${error.id} has verdict ${error.verdict ?? "none"}, not pass: accept --force to accept it anyway`;
  }
}

function orList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

export function exitFor(error: AppError): ExitCode {
  switch (error.kind) {
    case "store":
      return error.error.kind === "not_found" ? EXIT.notFound : EXIT.unexpected;
    case "git":
      return error.error.kind === "conflict" || error.error.kind === "dirty"
        ? EXIT.conflict
        : EXIT.unexpected;
    case "not_pass":
      return EXIT.notPass;
    case "brief":
    case "brief_unreadable":
    case "missing_env":
    case "empty_feedback":
    case "wrong_state":
      return EXIT.usage;
    case "lifecycle":
    case "worker":
      return EXIT.unexpected;
  }
}
