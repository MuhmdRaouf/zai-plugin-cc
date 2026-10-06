import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  finalizeWorker,
  INITIAL_PROGRESS,
  type Progress,
  parseStreamLine,
  reduceProgress,
  type StreamEvent,
} from "../../src/domain/stream.ts";

const FIXTURES = new URL("../fixtures/stream/", import.meta.url);

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(name, FIXTURES), "utf8").split("\n");
}

function fixtureLine(name: string, lineNumber: number): string {
  const line = fixtureLines(name)[lineNumber - 1];
  if (line === undefined) throw new Error(`${name} has no line ${lineNumber}`);
  return line;
}

function fixtureEvents(name: string): StreamEvent[] {
  return fixtureLines(name).flatMap((line) => {
    const parsed = parseStreamLine(line);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
    return [...parsed.value];
  });
}

function resultEvent(overrides: Partial<Extract<StreamEvent, { type: "result" }>> = {}): StreamEvent {
  return {
    type: "result",
    isError: false,
    text: "",
    structuredOutput: null,
    turns: 1,
    durationMs: 10,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    apiErrorStatus: null,
    ...overrides,
  };
}

const CLEAN_EXIT: Parameters<typeof finalizeWorker>[1] = { code: 0, signal: null, stderrTail: "" };

describe("parseStreamLine", () => {
  it("system/init → init with session_id and model (fixture rate-limited-429.jsonl line 3)", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 3));

    expect(parsed).toEqual({
      ok: true,
      value: [{ type: "init", sessionId: "13d60183-de73-441c-ae75-5fc27a410511", model: "glm-5.3-flash" }],
    });
  });
  it("system/api_retry → api_retry with attempt, max_retries and error_status", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 7));

    expect(parsed).toEqual({
      ok: true,
      value: [{ type: "api_retry", attempt: 3, maxRetries: 10, status: 429 }],
    });
  });
  it("assistant message text blocks → assistant_text; tool_use blocks → tool_use with name and a short input summary", () => {
    const text = parseStreamLine(fixtureLine("success-edit.jsonl", 9));
    const edit = parseStreamLine(fixtureLine("success-edit.jsonl", 13));
    const bash = parseStreamLine(fixtureLine("tool-error.jsonl", 6));

    expect(text).toEqual({
      ok: true,
      value: [{ type: "assistant_text", text: "I'll fix the off-by-one in src/range.ts." }],
    });
    expect(edit).toEqual({
      ok: true,
      value: [{ type: "tool_use", name: "Edit", summary: "/work/repo/src/range.ts" }],
    });
    expect(bash).toEqual({ ok: true, value: [{ type: "tool_use", name: "Bash", summary: "npm test" }] });
  });
  it("tool_use summary is the most telling input field on one line, else compact JSON, capped at 80 chars", () => {
    const summaryOf = (input: unknown): string | undefined => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_x", name: "T", input }] },
      });
      const parsed = parseStreamLine(line);
      const event = parsed.ok ? parsed.value[0] : undefined;
      return event?.type === "tool_use" ? event.summary : undefined;
    };

    expect(summaryOf({ pattern: "TODO", path: "src" })).toBe("TODO");
    expect(summaryOf({ path: "src", glob: "*.ts" })).toBe("src");
    expect(summaryOf({ notebook_path: "a.ipynb" })).toBe("a.ipynb");
    expect(summaryOf({ url: "https://example.com", prompt: "read" })).toBe("https://example.com");
    expect(summaryOf({ query: "zod v4", allowed_domains: [] })).toBe("zod v4");
    expect(summaryOf({ description: "Explore", prompt: "find x" })).toBe("Explore");
    expect(summaryOf({ prompt: "find x" })).toBe("find x");
    expect(summaryOf({ skill: "tdd" })).toBe("tdd");
    expect(summaryOf({ command: "npm test\n  && npm run lint" })).toBe("npm test && npm run lint");
    expect(summaryOf({ todos: [{ id: 1 }] })).toBe('{"todos":[{"id":1}]}');
    expect(summaryOf({ command: "  npm test\n" })).toBe("npm test");
    expect(summaryOf({})).toBe("");
    expect(summaryOf("raw")).toBe("");
    expect(summaryOf(null)).toBe("");
    expect(summaryOf({ command: "x".repeat(200) })).toBe(`${"x".repeat(79)}…`);
    expect(summaryOf({ command: "x".repeat(80) })).toBe("x".repeat(80));
  });

  it("a multi-block assistant message keeps every block in order; adjacent text blocks join", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Running tests." },
          { type: "tool_use", id: "toolu_y", name: "Bash", input: { command: "npm test" } },
          { type: "text", text: "Then " },
          { type: "text", text: "lint." },
          { type: "tool_use", id: "toolu_z", name: "Bash", input: { command: "npm run lint" } },
        ],
      },
    });
    const twoTexts = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    });

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [
        { type: "assistant_text", text: "Running tests." },
        { type: "tool_use", name: "Bash", summary: "npm test" },
        { type: "assistant_text", text: "Then lint." },
        { type: "tool_use", name: "Bash", summary: "npm run lint" },
      ],
    });
    expect(parseStreamLine(twoTexts)).toEqual({ ok: true, value: [{ type: "assistant_text", text: "ab" }] });
  });

  it("api_retry without an HTTP status (network error) → status null", () => {
    const line =
      '{"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10, "error_status": null}';

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [{ type: "api_retry", attempt: 1, maxRetries: 10, status: null }],
    });
  });

  it("result with missing accounting fields counts them as 0, a missing text as empty, no api_error_status as null", () => {
    const line = '{"type": "result", "subtype": "error_max_turns", "is_error": true, "usage": null}';

    expect(parseStreamLine(line)).toEqual({
      ok: true,
      value: [
        {
          type: "result",
          isError: true,
          text: "",
          structuredOutput: null,
          turns: 0,
          durationMs: 0,
          costUsd: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          apiErrorStatus: null,
        },
      ],
    });
  });

  it("result carries the live api_error_status as apiErrorStatus; a non-numeric one reads as null", () => {
    const limited = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 16));
    const odd = parseStreamLine('{"type": "result", "is_error": true, "api_error_status": "429"}');

    expect(limited).toMatchObject({ ok: true, value: [{ type: "result", apiErrorStatus: 429 }] });
    expect(odd).toMatchObject({ ok: true, value: [{ type: "result", apiErrorStatus: null }] });
  });

  it("user messages: tool_result is_error omitted means success; any failed block makes it an error", () => {
    const user = (content: unknown): string =>
      JSON.stringify({ type: "user", message: { role: "user", content } });

    expect(parseStreamLine(user([{ type: "tool_result", tool_use_id: "a", content: "ok" }]))).toEqual({
      ok: true,
      value: [{ type: "tool_result", isError: false }],
    });
    expect(
      parseStreamLine(
        user([
          { type: "tool_result", tool_use_id: "a", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
        ]),
      ),
    ).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
  });

  it("user messages without tool_result blocks are other; text beside a tool_result is ignored", () => {
    const user = (content: unknown): string =>
      JSON.stringify({ type: "user", message: { role: "user", content } });
    const textOnly = user([{ type: "text", text: "Continue." }]);
    const mixed = user([
      { type: "text", text: "note" },
      { type: "tool_result", tool_use_id: "a", content: "boom", is_error: true },
    ]);

    expect(parseStreamLine(textOnly)).toEqual({ ok: true, value: [{ type: "other", raw: textOnly }] });
    expect(parseStreamLine(mixed)).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
  });

  it("stream_event content_block_delta text → text_delta", () => {
    const parsed = parseStreamLine(fixtureLine("success-edit.jsonl", 7));

    expect(parsed).toEqual({ ok: true, value: [{ type: "text_delta", text: "off-by-one in " }] });
  });
  it("user tool_result blocks → tool_result with is_error", () => {
    const failed = parseStreamLine(fixtureLine("tool-error.jsonl", 10));
    const succeeded = parseStreamLine(fixtureLine("success-edit.jsonl", 17));

    expect(failed).toEqual({ ok: true, value: [{ type: "tool_result", isError: true }] });
    expect(succeeded).toEqual({ ok: true, value: [{ type: "tool_result", isError: false }] });
  });
  it("result → result reading is_error independently of subtype (fixture: subtype success + is_error true)", () => {
    const parsed = parseStreamLine(fixtureLine("rate-limited-429.jsonl", 16));

    expect(parsed).toMatchObject({
      ok: true,
      value: [
        {
          type: "result",
          isError: true,
          text: "API Error: Request rejected (429) · [1302][Rate limit reached for requests][202610060644290fbcd9bc36024c65]",
          structuredOutput: null,
        },
      ],
    });
  });
  it("result maps usage tokens (input, output, cache read, cache creation) and total_cost_usd, num_turns, duration_ms", () => {
    const parsed = parseStreamLine(fixtureLine("success-edit.jsonl", 26));

    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          type: "result",
          isError: false,
          text: "Fixed the off-by-one in range().",
          structuredOutput: {
            summary: "Fixed the off-by-one in range()",
            files: [{ path: "src/range.ts", why: "end bound was exclusive" }],
            root_cause: "loop used < instead of <=",
            tests_added: [],
            open_items: [],
          },
          turns: 3,
          durationMs: 42130,
          costUsd: 0.0123,
          usage: { inputTokens: 4200, outputTokens: 310, cacheReadTokens: 2800, cacheWriteTokens: 900 },
          apiErrorStatus: null,
        },
      ],
    });
  });
  it("unknown types and hook events → other, never an error", () => {
    const lines = [
      fixtureLine("rate-limited-429.jsonl", 1),
      fixtureLine("rate-limited-429.jsonl", 2),
      fixtureLine("rate-limited-429.jsonl", 4),
      fixtureLine("success-edit.jsonl", 1),
      fixtureLine("success-edit.jsonl", 4),
      '{"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}}',
      '{"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}]}}',
      '{"type": "user", "message": {"role": "user", "content": "plain prompt text"}}',
      '{"type": "result", "subtype": "success"}',
      "[1, 2]",
    ];

    for (const line of lines) {
      expect(parseStreamLine(line)).toEqual({ ok: true, value: [{ type: "other", raw: line }] });
    }
  });
  it("blank line → no events; malformed JSON → error with a short message", () => {
    const truncated = `{"type": "assistant", "message": {"content": [{"type": "text", "text": "${"x".repeat(500)}`;

    expect(parseStreamLine("")).toEqual({ ok: true, value: [] });
    expect(parseStreamLine("  \t\r")).toEqual({ ok: true, value: [] });
    const malformed = parseStreamLine(truncated);
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error).toMatch(/^malformed JSON: /);
    expect(malformed.error.length).toBeLessThanOrEqual(120);
  });
  it("parses every line of every fixture without error", () => {
    const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".jsonl"));
    expect(names).toEqual(
      expect.arrayContaining([
        "crash-no-result.jsonl",
        "rate-limited-429.jsonl",
        "success-edit.jsonl",
        "tool-error.jsonl",
      ]),
    );

    for (const name of names) {
      const lines = fixtureLines(name).filter((line) => line !== "");
      for (const [index, line] of lines.entries()) {
        const parsed = parseStreamLine(line);
        expect(parsed, `${name} line ${index + 1}`).toMatchObject({ ok: true, value: [expect.any(Object)] });
      }
    }
  });
});

describe("reduceProgress", () => {
  it("INITIAL_PROGRESS is starting, with no text, no session and zero counters", () => {
    expect(INITIAL_PROGRESS).toEqual({
      phase: "starting",
      turns: 0,
      lastText: "",
      rateLimitRetries: 0,
      toolCalls: 0,
      toolErrors: 0,
    });
  });

  it("init sets sessionId and phase thinking", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, { type: "init", sessionId: "s-1", model: "glm-5.3" });

    expect(progress).toEqual({ ...INITIAL_PROGRESS, sessionId: "s-1", phase: "thinking" });
  });
  it("api_retry with status 429 sets phase rate_limited and increments rateLimitRetries", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking", rateLimitRetries: 2 };

    const progress = reduceProgress(thinking, { type: "api_retry", attempt: 3, maxRetries: 10, status: 429 });

    expect(progress).toEqual({ ...thinking, phase: "rate_limited", rateLimitRetries: 3 });
  });

  it("api_retry for anything but 429 (overload, network) is not rate-limit pressure: progress unchanged", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };

    expect(reduceProgress(thinking, { type: "api_retry", attempt: 1, maxRetries: 10, status: 529 })).toBe(
      thinking,
    );
    expect(reduceProgress(thinking, { type: "api_retry", attempt: 1, maxRetries: 10, status: null })).toBe(
      thinking,
    );
  });
  it("text_delta accumulates lastText, capped to the last 500 chars; assistant_text replaces it", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };
    const delta = (text: string): StreamEvent => ({ type: "text_delta", text });

    const started = reduceProgress(thinking, delta("Hello, "));
    const continued = reduceProgress(started, delta("world"));
    const long = reduceProgress(continued, delta("y".repeat(600)));
    const completed = reduceProgress(long, { type: "assistant_text", text: "Hello, world" });

    expect(started).toEqual({ ...thinking, phase: "writing", lastText: "Hello, " });
    expect(continued.lastText).toBe("Hello, world");
    expect(long.lastText).toBe("y".repeat(500));
    expect(completed).toEqual({ ...long, phase: "thinking", lastText: "Hello, world" });
  });

  it("assistant_text keeps only the last 500 chars of a long message", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, {
      type: "assistant_text",
      text: `${"a".repeat(10)}${"b".repeat(500)}`,
    });

    expect(progress.lastText).toBe("b".repeat(500));
  });

  it("the first text_delta of a new message resets lastText (deltas accumulate per message)", () => {
    const afterMessage: Progress = { ...INITIAL_PROGRESS, phase: "thinking", lastText: "previous message" };

    const progress = reduceProgress(afterMessage, { type: "text_delta", text: "Next" });

    expect(progress).toEqual({ ...afterMessage, phase: "writing", lastText: "Next" });
  });
  it("tool_use sets phase tool, lastTool, increments toolCalls; tool_result with error increments toolErrors", () => {
    const writing: Progress = { ...INITIAL_PROGRESS, phase: "writing", toolCalls: 1, toolErrors: 1 };

    const calling = reduceProgress(writing, { type: "tool_use", name: "Bash", summary: "npm test" });
    const failed = reduceProgress(calling, { type: "tool_result", isError: true });
    const succeeded = reduceProgress(failed, { type: "tool_result", isError: false });

    expect(calling).toEqual({ ...writing, phase: "tool", lastTool: "Bash npm test", toolCalls: 2 });
    expect(failed).toEqual({ ...calling, phase: "thinking", toolErrors: 2 });
    expect(succeeded).toEqual(failed);
  });

  it("lastTool is the bare tool name when the input has nothing to summarize", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, { type: "tool_use", name: "TodoWrite", summary: "" });

    expect(progress.lastTool).toBe("TodoWrite");
  });
  it("result sets phase done and turns", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };
    const result: StreamEvent = {
      type: "result",
      isError: false,
      text: "done",
      structuredOutput: null,
      turns: 7,
      durationMs: 1000,
      costUsd: 0.5,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      apiErrorStatus: null,
    };

    expect(reduceProgress(thinking, result)).toEqual({ ...thinking, phase: "done", turns: 7 });
  });
  it("other events leave progress unchanged (same object)", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking", lastText: "x" };

    expect(reduceProgress(thinking, { type: "other", raw: '{"type": "system", "subtype": "status"}' })).toBe(
      thinking,
    );
  });
});

describe("finalizeWorker", () => {
  it("result with is_error false → completed, report = structured_output", () => {
    const finished = finalizeWorker(fixtureEvents("success-edit.jsonl"), CLEAN_EXIT, null);

    expect(finished.outcome).toEqual({ kind: "completed" });
    expect(finished.report).toEqual({
      summary: "Fixed the off-by-one in range()",
      files: [{ path: "src/range.ts", why: "end bound was exclusive" }],
      root_cause: "loop used < instead of <=",
      tests_added: [],
      open_items: [],
    });
  });
  it("result with is_error true → api_error with the result text; status 429 when the text contains (429)", () => {
    const limited = "API Error: Request rejected (429) · [1302][Rate limit reached for requests]";
    const plain = "API Error: Connection error.";

    const rateLimited = finalizeWorker([resultEvent({ isError: true, text: limited })], CLEAN_EXIT, null);
    const other = finalizeWorker([resultEvent({ isError: true, text: plain })], CLEAN_EXIT, null);

    expect(rateLimited.outcome).toEqual({ kind: "api_error", message: limited, status: 429 });
    expect(other.outcome).toEqual({ kind: "api_error", message: plain });
  });
  it("prefers the result's apiErrorStatus over a status found in the text", () => {
    const text = "API Error: Request rejected (429) · upstream said (503)";

    const live = finalizeWorker(
      [resultEvent({ isError: true, text, apiErrorStatus: 529 })],
      CLEAN_EXIT,
      null,
    );
    const fromText = finalizeWorker([resultEvent({ isError: true, text })], CLEAN_EXIT, null);

    expect(live.outcome).toEqual({ kind: "api_error", message: text, status: 529 });
    expect(fromText.outcome).toEqual({ kind: "api_error", message: text, status: 429 });
  });
  it("the rate-limited-429 fixture → api_error status 429 with rateLimitRetries 10", () => {
    const finished = finalizeWorker(
      fixtureEvents("rate-limited-429.jsonl"),
      { ...CLEAN_EXIT, code: 1 },
      null,
    );

    expect(finished.outcome).toEqual({
      kind: "api_error",
      message:
        "API Error: Request rejected (429) · [1302][Rate limit reached for requests][202610060644290fbcd9bc36024c65]",
      status: 429,
    });
    expect(finished.usage.rateLimitRetries).toBe(10);
  });
  it("forced timeout/stopped wins over any result", () => {
    const completed = fixtureEvents("success-edit.jsonl");
    const killed = { code: null, signal: "SIGTERM", stderrTail: "" };

    expect(finalizeWorker(completed, killed, "timeout").outcome).toEqual({ kind: "timeout" });
    expect(finalizeWorker(completed, killed, "stopped").outcome).toEqual({ kind: "stopped" });
    expect(finalizeWorker([], killed, "stopped").outcome).toEqual({ kind: "stopped" });
  });
  it("no result event and non-zero exit → crashed with code, signal and stderr tail", () => {
    const exit = { code: 137, signal: "SIGKILL", stderrTail: "FATAL ERROR: heap out of memory" };

    const finished = finalizeWorker(fixtureEvents("crash-no-result.jsonl"), exit, null);

    expect(finished.outcome).toEqual({
      kind: "crashed",
      exitCode: 137,
      signal: "SIGKILL",
      stderrTail: "FATAL ERROR: heap out of memory",
    });
    expect(finished.report).toBeNull();
  });
  it("no result event and exit 0 → crashed (a run must end with a result)", () => {
    const finished = finalizeWorker(fixtureEvents("crash-no-result.jsonl"), CLEAN_EXIT, null);

    expect(finished.outcome).toEqual({ kind: "crashed", exitCode: 0, signal: null, stderrTail: "" });
  });
  it("usage sums tokens from the last result and counts api_retry events", () => {
    // Only 429s count: rateLimitRetries feeds the AIMD limiter, and an overloaded (529) or network retry is not
    // pressure on the shared Z.ai request budget.
    const retry = (status: number | null): StreamEvent => ({
      type: "api_retry",
      attempt: 1,
      maxRetries: 10,
      status,
    });
    const events: StreamEvent[] = [
      retry(429),
      resultEvent({
        turns: 1,
        usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 },
      }),
      retry(529),
      retry(null),
      retry(429),
      resultEvent({
        turns: 4,
        durationMs: 5000,
        costUsd: 0.25,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 },
      }),
    ];

    expect(finalizeWorker(events, CLEAN_EXIT, null).usage).toEqual({
      turns: 4,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      costUsd: 0.25,
      rateLimitRetries: 2,
      durationMs: 5000,
    });
  });

  it("usage is all zeros but the retry count when no result arrived", () => {
    const events: StreamEvent[] = [{ type: "api_retry", attempt: 1, maxRetries: 10, status: 429 }];

    expect(finalizeWorker(events, CLEAN_EXIT, null).usage).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      rateLimitRetries: 1,
      durationMs: 0,
    });
  });
  it("sessionId comes from init", () => {
    const withInit = finalizeWorker(fixtureEvents("success-edit.jsonl"), CLEAN_EXIT, null);
    const withoutInit = finalizeWorker([resultEvent()], CLEAN_EXIT, null);

    expect(withInit.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(withoutInit).not.toHaveProperty("sessionId");
  });
});
