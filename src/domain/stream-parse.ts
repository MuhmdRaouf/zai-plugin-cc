import { z } from "zod";
import type { StreamEvent } from "./stream.ts";
import { summarizeToolInput } from "./stream-summary.ts";

/**
 * Wire shapes of the stream-json lines we act on. Schemas only name the keys we read (zod strips the rest), so new
 * keys in later Claude Code versions are harmless; a shape that no longer matches degrades to `other`.
 */
const systemInit = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string(),
});

const systemApiRetry = z.object({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number(),
  max_retries: z.number(),
  error_status: z.number().nullish(),
});

const contentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
]);

/** An assistant message: usually one content block, but every block is kept, in order; blocks we do not track
 *  (thinking) are skipped. */
const assistantMessage = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});

function decodeAssistant(json: unknown): readonly StreamEvent[] | undefined {
  const parsed = assistantMessage.safeParse(json);
  if (!parsed.success) return undefined;
  const events: StreamEvent[] = [];
  for (const candidate of parsed.data.message.content) {
    const block = contentBlock.safeParse(candidate);
    if (!block.success) continue;
    if (block.data.type === "tool_use") {
      events.push({ type: "tool_use", name: block.data.name, summary: summarizeToolInput(block.data.input) });
      continue;
    }
    const previous = events.at(-1);
    // Adjacent text blocks are one piece of prose split by the API, not separate messages.
    if (previous?.type === "assistant_text") events[events.length - 1] = joinText(previous, block.data.text);
    else events.push({ type: "assistant_text", text: block.data.text });
  }
  return events.length > 0 ? events : undefined;
}

function joinText(previous: { readonly text: string }, text: string): StreamEvent {
  return { type: "assistant_text", text: previous.text + text };
}

const toolResultBlock = z.object({ type: z.literal("tool_result"), is_error: z.boolean().optional() });

/** Tool results come back as a user message; `is_error` is omitted when the tool succeeded. */
const userMessage = z.object({
  type: z.literal("user"),
  message: z.object({ content: z.array(z.unknown()) }),
});

function decodeToolResult(json: unknown): readonly StreamEvent[] | undefined {
  const parsed = userMessage.safeParse(json);
  if (!parsed.success) return undefined;
  const results = parsed.data.message.content.flatMap((candidate) => {
    const block = toolResultBlock.safeParse(candidate);
    return block.success ? [block.data] : [];
  });
  if (results.length === 0) return undefined;
  return [{ type: "tool_result", isError: results.some((block) => block.is_error === true) }];
}

/** `--include-partial-messages` wraps raw API streaming events as `{type: "stream_event", event}`. */
const textDelta = z.object({
  type: z.literal("stream_event"),
  event: z.object({
    type: z.literal("content_block_delta"),
    delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
  }),
});

/** Accounting fields never cost us the result event: a missing or odd value counts as 0. */
const count = z.number().catch(0);

const NO_TOKENS = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** `is_error` is authoritative: `subtype: "success"` with `is_error: true` happens on API errors (live capture). */
const resultMessage = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  num_turns: count,
  duration_ms: count,
  total_cost_usd: count,
  /** HTTP status of the failed API call (live field); absent on success. */
  api_error_status: z.number().nullish().catch(null),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      cache_read_input_tokens: count,
      cache_creation_input_tokens: count,
    })
    .catch(NO_TOKENS),
});

function decodeResult(json: unknown): readonly StreamEvent[] | undefined {
  const parsed = resultMessage.safeParse(json);
  if (!parsed.success) return undefined;
  const { usage, ...data } = parsed.data;
  return [
    {
      type: "result",
      isError: data.is_error,
      text: data.result ?? "",
      structuredOutput: data.structured_output ?? null,
      turns: data.num_turns,
      durationMs: data.duration_ms,
      costUsd: data.total_cost_usd,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
      },
      apiErrorStatus: data.api_error_status ?? null,
    },
  ];
}

type Decoder = (json: unknown) => readonly StreamEvent[] | undefined;

const decoders: readonly Decoder[] = [
  (json) => {
    const parsed = systemInit.safeParse(json);
    return parsed.success
      ? [{ type: "init", sessionId: parsed.data.session_id, model: parsed.data.model }]
      : undefined;
  },
  (json) => {
    const parsed = systemApiRetry.safeParse(json);
    if (!parsed.success) return undefined;
    const { attempt, max_retries, error_status } = parsed.data;
    return [{ type: "api_retry", attempt, maxRetries: max_retries, status: error_status ?? null }];
  },
  decodeAssistant,
  (json) => {
    const parsed = textDelta.safeParse(json);
    return parsed.success ? [{ type: "text_delta", text: parsed.data.event.delta.text }] : undefined;
  },
  decodeToolResult,
  decodeResult,
];

/** A decoded JSON value → the events it represents, or one `other` carrying the raw line. */
export function toStreamEvents(json: unknown, raw: string): readonly StreamEvent[] {
  for (const decode of decoders) {
    const events = decode(json);
    if (events !== undefined) return events;
  }
  return [{ type: "other", raw }];
}
